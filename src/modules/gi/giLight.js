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
  Loop,
  abs,
  acos,
  cameraPosition,
  cameraProjectionMatrix,
  cos,
  equirectUV,
  float,
  int,
  materialRoughness,
  mix,
  normalWorld,
  positionWorld,
  reflect,
  renderGroup,
  screenUV,
  select,
  sin,
  smoothstep,
  step,
  cross,
  ivec2,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { sharedFn } from "./giFn.js";
import { isFlatTexture, isLayeredTexture } from "./materialNodeBindings.js";
import { sampleReflectionProbes } from "./reflectionProbes.js";

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
// it). Authored scalar materials leave that block at GI_EXACT_TAIL_ZERO,
// where every exact-reflection consumer has zero weight; mapped/dynamic
// materials stay conservative because a scalar cannot describe every texel.
// Likewise, above SPECULAR_MAX
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
  // ── §16 R4 — THE ROUGHNESS FLOOR (2026-08-24) ─────────────────────────────
  //
  // A roughness MAP used to mean bucket 3 unconditionally, and on real
  // imported scenes that is nearly every material: the user's Bistro reads
  // "2 mirror, 102 dynamic-roughness", so the exact-reflection prepass
  // traced the ENTIRE screen through a 1.5M-tri BVH (146-286 ms measured
  // live) to produce a term the material side then multiplies by
  // `smoothstep(0.45, 0.15, roughness)` ≈ ZERO on almost every pixel —
  // plaster and wood are not mirrors just because their roughness varies.
  //
  // The floor is the map's resolved LOWER BOUND (p5 of per-texel min(RGB),
  // times any constant/uniform factor — see `giRoughnessSourceOf`). A
  // material whose roughness never reaches the mirror gate cannot consume
  // an exact reflection ANYWHERE on its surface, so it classifies by its
  // floor instead of paying bucket 3. Stats resolve ASYNC (GPU blit for
  // KTX2) — until one lands the material stays conservatively in bucket 3
  // and the existing #refreshMirrorBucket healing recompiles it when the
  // stat arrives. `__giRoughnessFloorClassify = false` reverts.
  // ⚠ OPT-IN (=== true) SINCE 2026-08-24 LATE — REFUTED AS A DEFAULT, twice
  // in one night, by the user's eyes + two A/B boots on Sponza:
  //   floor → bucket 2: shadowed walls went near-black (diffuse-only
  //     compiles out the whole directional chain);
  //   floor → bucket 1: STILL murky — the missing energy is the
  //     canMirror block's HIT-SHADED EXACT RADIANCE itself. At grazing
  //     angles Fresnel drives rough-surface specular high, so the "term
  //     smoothstep zeroes" premise is wrong for the hit-shade path: on
  //     Sponza those traces paint a real share of every shadowed wall.
  // The 22.7 ms is real lighting, not waste. The perf lever is making the
  // prepass CHEAPER for rough pixels (they are low-frequency — coarse
  // stride + the existing block replication), not removing them. The
  // channel-floor machinery below stays correct and gated for that design.
  if (globalThis.__giRoughnessFloorClassify === true) {
    const src = giRoughnessSourceOf(material);
    const stats = src?.tex ? giRoughnessFloorStats.get(src.tex) : undefined;
    if (stats) {
      // Pick the floor for the channel the material actually samples.
      // min-RGB is the fallback for an unknown channel only — on a glTF
      // packed metallicRoughness map (B = metalness ≈ 0 on dielectrics)
      // min-RGB is ~0 on EVERY texel, which silently kept every packed-map
      // material in the consumer set (the Sponza 24/39 regression). Legacy
      // number-shaped stats (pre per-channel) still read as the min floor.
      const texFloor =
        typeof stats === "number" ? stats : (stats[src.channel] ?? stats.min);
      if (typeof texFloor === "number") {
        const floor = Math.min(1, texFloor * src.factor);
        // ⚠ BUCKET 1, NEVER BUCKET 2 (2026-08-24, the user's "shadowed
        // areas too dark/murky" — A/B-confirmed the same night). Bucket 2
        // compiles ONLY irradiance/π: the whole directional radiance chain
        // (cascade lookups, reflection probes, the rough-lobe collapse) is
        // compiled OUT, and on real scenes that chain carries a visible
        // share of every shadowed wall's light even at roughness 0.7+.
        // What R4 exists to kill is the EXACT-reflection cost, and that is
        // bucket 0/3 membership (the mirror mask + bvhShade readers) —
        // bucket 1 already avoids all of it while keeping the energy. The
        // map-floor path therefore never demotes past 1; only an AUTHORED
        // constant roughness (the artist's explicit intent, below) may
        // still choose the diffuse-only limit.
        if (floor > GI_MIRROR_ROUGHNESS_MAX) return 1;
      }
    }
  }
  if (material.roughnessMap) return 3;
  const r = staticRoughnessOf(material);
  if (r === null) return 3;
  // Every sharp-image consumer is exactly zero at GI_EXACT_TAIL_ZERO. For an
  // authored scalar that makes the exact trace + hit-shade path dead code, so
  // do not keep the material in bucket 0 merely because the older broad
  // reflection ramp extends to GI_MIRROR_ROUGHNESS_MAX. Maps and unrecognised
  // nodes returned above remain conservative: their scalar is not a per-pixel
  // bound and therefore cannot safely make this cut.
  return r < GI_EXACT_TAIL_ZERO ? 0 : r < GI_SPECULAR_ROUGHNESS_MAX ? 1 : 2;
}

/**
 * §16 R4 — resolved roughness-map floors, keyed by TEXTURE. Written by
 * GISystem's async stat resolution (readTexturePixelsGPU — KTX2-safe),
 * read by `giRoughnessBucketOf` above. A WeakMap so a released texture
 * releases its stat.
 */
export const giRoughnessFloorStats = new WeakMap();

/**
 * §18 — THE REFLECTION QUALITY LADDER. How FINELY a surface's reflection must
 * be sampled, from its roughness LOWER BOUND. 0 = sharp, 1 = medium, 2 = coarse.
 *
 * ⚠⚠ THIS IS A RESOLUTION DECISION AND NEVER A PATH DECISION, and that
 * distinction is the entire reason it is safe where §16 R4 was not. R4 used
 * these same floors to move materials OUT of the exact-reflection path, and the
 * user's eyes refuted it in one night: the hit-shaded exact radiance is REAL
 * LIGHT (at grazing angles Fresnel drives rough-surface specular high), so
 * dropping it turned shadowed walls near-black. Nothing here changes which
 * terms a material compiles or which code path it takes — every surface keeps
 * the reflection it has today. The tier only says how many rays pay for it.
 * A wrong tier therefore costs SHARPNESS or SPEED, never energy.
 *
 * ## Why the ladder exists at all
 *
 * The engine had exactly TWO tiers: bucket 0 (mirror) and bucket 3 (everything
 * with a roughness map). On the user's Bistro that is **2 materials against
 * 102** — so window glass and wall plaster are in the same tier and get
 * identical treatment. Both halves of that are wrong at once: the glass is
 * denied the sharp trace it needs (its reflection arrives as a blurry, blobby
 * probe-field gather — the user's "blurry, noisy, dirty" windows), while the
 * plaster pays FULL-RESOLUTION PER-PIXEL BVH TRACING at ultra (25.77 ms of a
 * ~52 ms GPU frame) to produce something that is then blurred anyway.
 * User, 2026-08-24: *"for some surfaces we need much cleaner reflection while
 * others, like a wet carpet, would do with a very low res."*
 *
 * ## Why the FLOOR, not the mean
 *
 * The floor is the roughness LOWER BOUND over the map (§16 R4's per-channel p5).
 * Keying on it is deliberately conservative in the QUALITY direction: a surface
 * with any smooth region is traced finely across the whole surface, so the
 * ladder can never under-sample a mirror-like patch. It costs some perf on
 * mixed maps and cannot produce a sharpness regression, which is the right way
 * round for a change the user has to look at.
 *
 * An UNRESOLVED floor (the async GPU stat has not landed, or the roughness
 * expression is not one the bounded walk recognises) returns MEDIUM rather than
 * SHARP or COARSE — the middle is the only answer that is not a guess in either
 * direction, and §16 R4's existing `#refreshMirrorBucket` drain re-derives it
 * when the stat arrives.
 */
export const GI_REFLECT_TIER = { SHARP: 0, MEDIUM: 1, COARSE: 2 };

/**
 * ⚠ THESE ARE NOT TUNING NUMBERS — they are read off the ramp that already
 * decides how much of the exact traced reflection survives, `exactWeight =
 * smoothstep(0.45, 0.15, roughness)` (giLight.js, the exact-blend site):
 *
 *   roughness <= 0.15  ->  exactWeight 1.00   the traced image is shown in full
 *   roughness  = 0.30  ->  exactWeight 0.50
 *   roughness >= 0.45  ->  exactWeight 0.00   the traced image is DISCARDED
 *
 * So the tiers are the ramp's own breakpoints. Picking independent constants
 * (the first cut used 0.12 / 0.35) means the ladder and the shader disagree
 * about what "sharp" is, and the scene's own MIRROR materials then fail to
 * qualify as sharp — which is exactly what the first census showed: 0 sharp.
 */
export const GI_TIER_SHARP_MAX = 0.15;
export const GI_TIER_MEDIUM_MAX = 0.45;

// A single traced direction is an honest representation only for the sharp
// end of the GGX lobe. Keep true mirrors byte-for-byte at full weight, then
// hand the rough-metal tail to the already-live broad radiance field before
// one coherent hit can become a bright metallic flash. These bounds are
// deliberately narrower than the trace-resolution tier above: the tier says
// what to SAMPLE, while this confidence says whether one sample can represent
// the material lobe. Scalar-material bucket classification also uses the zero
// endpoint so a provably dead exact path does not arm its passes; mapped and
// otherwise dynamic roughness remain conservative.
export const GI_EXACT_TAIL_FULL = GI_TIER_SHARP_MAX;
export const GI_EXACT_TAIL_ZERO = 0.28;

/** CPU mirror of the shader confidence, used by the focused policy gate. */
export function giExactTailWeight(roughness) {
  const r = Number.isFinite(Number(roughness)) ? Number(roughness) : 1;
  const x = Math.min(1, Math.max(0,
    (r - GI_EXACT_TAIL_FULL) / (GI_EXACT_TAIL_ZERO - GI_EXACT_TAIL_FULL),
  ));
  return 1 - x * x * (3 - 2 * x);
}

/**
 * Number of exact-reflection texture taps the material path needs.
 *
 * A true mirror has a zero-radius footprint, so all twelve ring taps read the
 * centre texel again. At the other end, once the sharp tail has zero weight,
 * the filtered value cannot reach the output. Both cases are exactly one-tap
 * evaluations; only the transition between them needs the 13-tap footprint.
 * Kept as a CPU mirror so the policy is testable without compiling WGSL.
 */
export function giExactPrefilterTapCount(roughness) {
  const r = Number.isFinite(Number(roughness)) ? Number(roughness) : 1;
  return r > 0.02 && giExactTailWeight(r) > 0 ? 13 : 1;
}

/** CPU mirror of the fixed-denominator exact-prefilter policy. */
export function giExactPrefilterMean(samples, broadFallback = 0) {
  if (!Array.isArray(samples) || samples.length === 0) return Number(broadFallback) || 0;
  const fallback = Number.isFinite(Number(broadFallback)) ? Number(broadFallback) : 0;
  const first = Number(samples[0]?.value);
  const center = samples[0]?.valid && Number.isFinite(first) ? first : fallback;
  let sum = 0;
  for (const sample of samples) {
    const value = Number(sample?.value);
    sum += sample?.valid && Number.isFinite(value)
      ? value
      : sample?.miss
        ? fallback
        : center;
  }
  return sum / samples.length;
}

function tierFromRoughness(r) {
  if (!(r >= 0)) return GI_REFLECT_TIER.MEDIUM;
  if (r <= GI_TIER_SHARP_MAX) return GI_REFLECT_TIER.SHARP;
  if (r <= GI_TIER_MEDIUM_MAX) return GI_REFLECT_TIER.MEDIUM;
  return GI_REFLECT_TIER.COARSE;
}

/**
 * The ladder, WITH ITS REASON — because `MEDIUM` is returned for two completely
 * different situations and reading them as one is a measuring instrument that
 * cannot see its own subject:
 *
 *   - the floor really is mid-range (0.15 < r <= 0.45), a settled answer;
 *   - the floor has NOT RESOLVED YET (the per-channel stat is computed
 *     asynchronously on the GPU), a placeholder.
 *
 * The first census shipped without the distinction and reported "0 sharp, 102
 * medium" on a scene whose windows are mirrors — which reads as "this scene has
 * no sharp surfaces" when it actually meant "ask again later". Any decision
 * made off a tier — a layer tag, a trace stride — must be re-taken when
 * `resolved` flips, so the caller has to be able to see it.
 *
 * @param {any} material
 * @returns {{ tier: number, roughness: number|null, resolved: boolean }}
 */
export function giReflectTierInfoOf(material) {
  const pending = { tier: GI_REFLECT_TIER.MEDIUM, roughness: null, resolved: false };
  if (!material) return { tier: GI_REFLECT_TIER.COARSE, roughness: null, resolved: true };
  // ⚠ THE MAP IS CHECKED FIRST, and that ordering is load-bearing:
  // `staticRoughnessOf` returns `material.roughness` — a NUMBER — even when a
  // roughness MAP is present, because there the scalar is only a MULTIPLIER on
  // the map. Reading it as the surface's roughness would tier every mapped
  // material by its multiplier (typically 1.0 → COARSE, or 0.0 → SHARP for the
  // whole scene). `giRoughnessBucketOf` checks `material.roughnessMap` before
  // `staticRoughnessOf` for exactly this reason.
  const src = giRoughnessSourceOf(material);
  if (!src?.tex) {
    // No per-pixel source: the AUTHORED constant is the artist's explicit
    // statement about the whole surface — no floor needed, no async wait.
    const constant = staticRoughnessOf(material);
    if (constant === null) return pending;
    return { tier: tierFromRoughness(constant), roughness: constant, resolved: true };
  }
  // Otherwise the map's floor, read through the SAME channel-aware path R4
  // built (min-RGB on a glTF packed metallicRoughness map is ~0 on every
  // dielectric texel, which would promote the entire scene to SHARP).
  const stats = giRoughnessFloorStats.get(src.tex);
  if (!stats) return pending;
  const texFloor = typeof stats === "number" ? stats : (stats[src.channel] ?? stats.min);
  if (typeof texFloor !== "number") return pending;
  const floor = Math.min(1, texFloor * src.factor);
  return { tier: tierFromRoughness(floor), roughness: floor, resolved: true };
}

/**
 * @param {any} material
 * @returns {number} one of `GI_REFLECT_TIER`
 */
export function giReflectTierOf(material) {
  return giReflectTierInfoOf(material).tier;
}

/** Whether this material can receive a non-zero exact-reflection tail. */
export function giNeedsExactTrace(material) {
  const bucket = giRoughnessBucketOf(material);
  // Scalar materials are exact consumers only below GI_EXACT_TAIL_ZERO.
  // Mapped/dynamic materials remain conservative until their floor resolves.
  return bucket === 0 || (
    bucket === 3 && giReflectTierOf(material) <= GI_REFLECT_TIER.MEDIUM
  );
}

/**
 * §16 R4 — the TEXTURE a material's per-pixel roughness comes from, plus the
 * product of every constant/uniform factor multiplied into it, or null when
 * the roughness expression is anything the bounded walk does not recognise
 * (those stay honestly dynamic).
 *
 * Recognised shapes: `material.roughnessMap` (three's own channel, glTF
 * imports — factor is the scalar `.roughness`), and a `roughnessNode` graph
 * of wrappers (VarNode/ConvertNode/SplitNode swizzles) over one TextureNode,
 * optionally multiplied by const/uniform scalars (the shader-graph "map ×
 * slider" case). Uniform factors are mutable — the same #refreshMirrorBucket
 * scan that heals a `.roughness` edit re-derives this too.
 */
export function giRoughnessSourceOf(material) {
  if (!material) return null;
  const node = material.roughnessNode;
  if (node == null) {
    return material.roughnessMap && !isLayeredTexture(material.roughnessMap)
      // three's PBR convention samples roughnessMap's GREEN channel
      // (glTF packed metallicRoughness: G = roughness, B = metalness) —
      // naming the channel is what lets the floor reader skip past the
      // packed map's near-zero B/min.
      ? { tex: material.roughnessMap, factor: material.roughness ?? 1, channel: "g" }
      : null;
  }
  let tex = null;
  let factor = 1;
  let channel = null;
  const walk = (n, depth) => {
    if (!n || depth > 10) return false;
    if (n.isTextureNode && n.value?.isTexture) {
      // A layered texture's texel depends on a per-vertex layer — no floor to read.
      if (!isFlatTexture(n.value)) return false;
      if (tex) return false; // two textures — not a shape we can bound
      tex = n.value;
      return true;
    }
    if (n.isConstNode || n.isUniformNode) {
      if (typeof n.value !== "number") return false;
      factor *= n.value;
      return true;
    }
    // mul(a, b): both sides must be recognised (one texture total).
    if (n.isOperatorNode && n.op === "*") {
      return walk(n.aNode, depth + 1) && walk(n.bNode, depth + 1);
    }
    // Wrappers that don't change the value bound: auto-var and converts.
    if (n.isVarNode || n.isConvertNode) {
      return walk(n.node, depth + 1);
    }
    // A channel swizzle NAMES the channel the material reads — record a
    // single-component swizzle so the floor reader can use that channel's
    // own p5 instead of the min-RGB fallback (degenerate on packed maps,
    // see giRoughnessBucketOf). ⚠ TSL NORMALIZES swizzles to xyzw at the
    // proxy (`setProtoSwizzle`: `.g`/`.t` construct SplitNode(node, 'y')),
    // so a live graph NEVER carries 'g' — matching rgb alone read every
    // real split as unknown and the drain reported 4 full cycles with
    // "no flips" against fully resolved floors (2026-08-24 heartbeats).
    // Multi-component or w/a swizzles keep the conservative fallback.
    if (n.isSplitNode) {
      const c = typeof n.components === "string" ? n.components : null;
      const mapped =
        c && c.length === 1
          ? ({ r: "r", g: "g", b: "b", x: "r", y: "g", z: "b" })[c] ?? null
          : null;
      if (mapped) channel = channel ?? mapped;
      return walk(n.node, depth + 1);
    }
    return false;
  };
  if (!walk(node, 0) || !tex) return null;
  return { tex, factor: Math.max(0, factor), channel };
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
export function staticRoughnessOf(material) {
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
 * ONE PLANAR EMITTING QUAD'S EXACT LAMBERT FORM FACTOR, CLIPPED TO THE
 * RECEIVER'S HORIZON. `p0..p3` are the corners as vectors FROM the receiver,
 * UNNORMALIZED and in winding order; `N` is the receiver normal.
 *
 * ══ WHY THE CLIP EXISTS, AND WHAT IT COST NOT TO HAVE IT ═══════════════════
 *
 * The contour formula (Baum et al.) integrates the WHOLE polygon whether or
 * not the receiver can see all of it, and the part below the tangent plane
 * integrates NEGATIVELY. This used to be answered with `max(faceSum, 0)` on
 * the face TOTAL, documented as "an under-estimate, smooth". It is neither.
 *
 * ⚠ **A HALF-VISIBLE FACE CLAMPED TO ZERO**, and since a box's opposing faces
 * are culled together by the facing test, a receiver sitting BETWEEN two of a
 * box's face planes lost every face at once. "Between two opposing face
 * planes" is exactly what it means for the emitter's mesh to OVERLAP the
 * receiver's — which is the user's 2026-08-20 report: *"the emitters do not
 * light surfaces if their meshes overlap with them, but when I move the
 * emitters lightly to the side they start emitting light"*.
 *
 * Measured against the brute-force MC arbiter (`test:gi-emitter-shapes`'s own
 * reference), a pillar face 0.05 m from a straddling emissive box read
 * **0.000 against a true 3.06**, stayed 0.14×–0.58× short through the whole
 * transition band, and snapped to 1.00× the instant the box cleared the
 * receiver's plane. A hard discontinuity in a physically smooth field — which
 * is why it reads as "no light at all" rather than "a little dim", and why
 * nudging the lamp fixes it.
 *
 * ⚠ **THE GATE PASSED THE WHOLE TIME.** Its horizon arm asserts only
 * `0 ≤ factor ≤ unoccluded MC` for straddling receivers — a bound that ZERO
 * satisfies. An interval that admits the failure is not a test of it; the arm
 * now compares against MC directly.
 *
 * ══ CLIP FIRST, INTEGRATE SECOND ═══════════════════════════════════════════
 *
 * Sutherland-Hodgman against `dot(v, N) = 0`, in LINEAR space — an edge meets
 * a plane linearly, the same point on the unit sphere does not, so normalizing
 * before the cut would bend every clipped edge. A quad cut by a plane keeps at
 * most 5 vertices, so the clip is Heitz's LTC 16-case config table (no dynamic
 * indexing, no loop): `config` is the four inside/outside bits, and each case
 * writes the survivors into a fixed 5-slot register file. Cases 5 and 10 —
 * opposite corners in, adjacent ones out — are geometrically impossible for a
 * convex quad and a plane, and fall out as n = 0.
 *
 * The unused tail slots are set to `L0` so the fixed 5-edge sum closes the
 * polygon and the extra edges are degenerate (`acos(1) = 0`), which keeps the
 * generated WGSL branch-free below the config chain. `max(0)` survives only as
 * a floating-point floor: after clipping every vertex is on or above the
 * tangent plane, so the sum cannot be meaningfully negative.
 */
const polyHorizonFactor = sharedFn({
  name: "giPolyHorizonFactor",
  type: "float",
  inputs: [
    { name: "N", type: "vec3" },
    { name: "p0", type: "vec3" },
    { name: "p1", type: "vec3" },
    { name: "p2", type: "vec3" },
    { name: "p3", type: "vec3" },
  ],
  body: (N, p0, p1, p2, p3) => {
    const a0 = vec3(p0).toVar(), a1 = vec3(p1).toVar();
    const a2 = vec3(p2).toVar(), a3 = vec3(p3).toVar();
    const nrm0 = (v) => v.div(v.length().max(1e-9));
    const edge0 = (a, b) => {
      const c = cross(a, b);
      return acos(a.dot(b).clamp(-1, 1)).mul(c.div(c.length().max(1e-6)).dot(N));
    };
    // A/B ARM — the pre-2026-08-20 behaviour, for measuring the fix on the same
    // machine and nothing else. `max(sum, 0)` on the UNCLIPPED quad.
    if (globalThis.__giPolyHorizonClip === false) {
      const q0 = nrm0(a0), q1 = nrm0(a1), q2 = nrm0(a2), q3 = nrm0(a3);
      return edge0(q0, q1).add(edge0(q1, q2)).add(edge0(q2, q3)).add(edge0(q3, q0)).mul(0.5).max(0);
    }
    const d0 = a0.dot(N).toVar(), d1 = a1.dot(N).toVar();
    const d2 = a2.dot(N).toVar(), d3 = a3.dot(N).toVar();
    // The four inside bits, as one integer the case chain switches on.
    const config = int(0).toVar();
    config.addAssign(select(d0.greaterThan(0), int(1), int(0)));
    config.addAssign(select(d1.greaterThan(0), int(2), int(0)));
    config.addAssign(select(d2.greaterThan(0), int(4), int(0)));
    config.addAssign(select(d3.greaterThan(0), int(8), int(0)));

    const L0 = vec3(0).toVar(), L1 = vec3(0).toVar(), L2 = vec3(0).toVar();
    const L3 = vec3(0).toVar(), L4 = vec3(0).toVar();
    const n = int(0).toVar();
    // Edge a→b crosses the plane at `d_a·b − d_b·a` up to a positive scale
    // (the normalize below eats the scale, and the sign is fixed because the
    // INSIDE endpoint's d is the positive one in every case here).
    const x = (da, va, db, vb) => vb.mul(da).sub(va.mul(db));

    If(config.equal(int(1)), () => {
      n.assign(int(3)); L0.assign(a0); L1.assign(x(d0, a0, d1, a1)); L2.assign(x(d0, a0, d3, a3));
    }).ElseIf(config.equal(int(2)), () => {
      n.assign(int(3)); L0.assign(x(d1, a1, d0, a0)); L1.assign(a1); L2.assign(x(d1, a1, d2, a2));
    }).ElseIf(config.equal(int(3)), () => {
      n.assign(int(4)); L0.assign(a0); L1.assign(a1); L2.assign(x(d1, a1, d2, a2)); L3.assign(x(d0, a0, d3, a3));
    }).ElseIf(config.equal(int(4)), () => {
      n.assign(int(3)); L0.assign(x(d2, a2, d3, a3)); L1.assign(x(d2, a2, d1, a1)); L2.assign(a2);
    }).ElseIf(config.equal(int(6)), () => {
      n.assign(int(4)); L0.assign(x(d1, a1, d0, a0)); L1.assign(a1); L2.assign(a2); L3.assign(x(d2, a2, d3, a3));
    }).ElseIf(config.equal(int(7)), () => {
      n.assign(int(5)); L0.assign(a0); L1.assign(a1); L2.assign(a2);
      L3.assign(x(d2, a2, d3, a3)); L4.assign(x(d0, a0, d3, a3));
    }).ElseIf(config.equal(int(8)), () => {
      n.assign(int(3)); L0.assign(x(d3, a3, d0, a0)); L1.assign(x(d3, a3, d2, a2)); L2.assign(a3);
    }).ElseIf(config.equal(int(9)), () => {
      n.assign(int(4)); L0.assign(a0); L1.assign(x(d0, a0, d1, a1)); L2.assign(x(d3, a3, d2, a2)); L3.assign(a3);
    }).ElseIf(config.equal(int(11)), () => {
      n.assign(int(5)); L0.assign(a0); L1.assign(a1); L2.assign(x(d1, a1, d2, a2));
      L3.assign(x(d3, a3, d2, a2)); L4.assign(a3);
    }).ElseIf(config.equal(int(12)), () => {
      n.assign(int(4)); L0.assign(x(d3, a3, d0, a0)); L1.assign(x(d2, a2, d1, a1)); L2.assign(a2); L3.assign(a3);
    }).ElseIf(config.equal(int(13)), () => {
      n.assign(int(5)); L0.assign(a0); L1.assign(x(d0, a0, d1, a1)); L2.assign(x(d2, a2, d1, a1));
      L3.assign(a2); L4.assign(a3);
    }).ElseIf(config.equal(int(14)), () => {
      n.assign(int(5)); L0.assign(x(d1, a1, d0, a0)); L1.assign(a1); L2.assign(a2); L3.assign(a3);
      L4.assign(x(d3, a3, d0, a0));
    }).ElseIf(config.equal(int(15)), () => {
      n.assign(int(4)); L0.assign(a0); L1.assign(a1); L2.assign(a2); L3.assign(a3);
    });
    // n == 3 closes at L3, n == 4 at L4; the leftover edges become (L0, L0).
    L3.assign(select(n.lessThanEqual(int(3)), L0, L3));
    L4.assign(select(n.lessThanEqual(int(4)), L0, L4));

    const nrm = (v) => v.div(v.length().max(1e-9));
    const u0 = nrm(L0).toVar(), u1 = nrm(L1).toVar(), u2 = nrm(L2).toVar();
    const u3 = nrm(L3).toVar(), u4 = nrm(L4).toVar();
    const edge = (a, b) => {
      const c = cross(a, b);
      return acos(a.dot(b).clamp(-1, 1)).mul(c.div(c.length().max(1e-6)).dot(N));
    };
    const sum = edge(u0, u1).add(edge(u1, u2)).add(edge(u2, u3))
      .add(edge(u3, u4)).add(edge(u4, u0)).mul(0.5);
    return sum.max(0).mul(select(n.greaterThan(int(0)), float(1), float(0)));
  },
});

/**
 * Exact Lambert form factor of an ORIENTED-BOX area light: E = radiance · F,
 * F ∈ [0, π]. Each receiver-facing face is clipped to the receiver's horizon
 * and integrated with the classic contour formula for a diffuse polygon
 * (Baum et al.): Σ over edges of acos(u_i·u_j) · (normalize(u_i×u_j) · N),
 * halved — see `polyHorizonFactor`, which owns both halves and is where the
 * horizon clip and its history live. This is what makes an emissive CUBE
 * light its surroundings like a cube — the sphere model gave every emitter
 * circular iso-lux contours and a round "reflection", which users read as
 * "my box lamp reflects as a sphere".
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
        // UNNORMALIZED, deliberately — the horizon clip inside cuts in linear
        // space and normalizes after (see `polyHorizonFactor`).
        const u0 = faceCenter.add(eu).add(ev).sub(P).toVar();
        const u1 = faceCenter.add(eu).sub(ev).sub(P).toVar();
        const u2 = faceCenter.sub(eu).sub(ev).sub(P).toVar();
        const u3 = faceCenter.sub(eu).add(ev).sub(P).toVar();
        F.addAssign(polyHorizonFactor(N, u0, u1, u2, u3));
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

export function emitterDirectAt(params, P, N, samplePoint, options = null) {
  // `{ rolled: true }` — one traced march per program instead of one per
  // seat; only for the traced path (a caller-supplied `shadowSample(index)`
  // indexes a texture per slot and stays unrolled). See emitterDirectAtRolled.
  // (2026-09-02, late) The roll was blamed for a black mirror on
  // `test:gi-hit-shade` and made opt-in for an evening; the black was the
  // exact-reflection prepass HELD before it had ever traced (GISystem's
  // reflect hold), and every "lit" arm was the glossy fallback read before
  // the hit shade's pipeline landed — the roll only moved that landing
  // (11.5 s → 3.9 s on the rig). `__giRolledEmitter = false` unrolls.
  if (options?.rolled && globalThis.__giRolledEmitter !== false && !params.shadowSample && params.emitterSlots.length > 1) {
    return emitterDirectAtRolled(params, P, N, samplePoint);
  }
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
    //
    // §14 Q4: the fade band sits ABOVE the trace admission, not below it.
    // The previous `smoothstep(cutD/3, cutD, lum)` reached full strength AT
    // the admission threshold and zero a band BELOW it — so the entire
    // visible tail [cutD/3, cutD] was delivered UNSHADOWED (admission is
    // `lum > traceCut ≈ cutD`), which is exactly the through-the-wall leak,
    // and its C1 corner at the band edge drew a Mach band on open floors.
    // Now: zero exactly where tracing ends (no visible photon is ever
    // unshadowed on the primary path), full at 3× the threshold, and the
    // ramp is the C2 smootherstep so neither edge has a second-derivative
    // corner for the eye to find. Tier `emitterCutoff` values were halved in
    // the same change so the zero-point (the perceived reach) stays close to
    // where it was.
    const emitterLum = emitterDirect.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
    const cutD = emitterCutoff(params);
    const fadeT = emitterLum.sub(cutD).div(cutD * 2).clamp(0, 1).toVar();
    emitterDirect.mulAssign(
      fadeT.mul(fadeT).mul(fadeT).mul(fadeT.mul(fadeT.mul(6).sub(15)).add(10)),
    );
    // PRE-TRACED CHANNEL (2026-08-06): when the emitter shadows run as their
    // own pass at their own pixel budget (giScreen's emitter shadow pass —
    // the same split that took the direct arm from 22ms to 5.4ms at 4×
    // pixels), the resolve just SAMPLES the filtered texture; the trace
    // lives in exactly one kernel. The hit-shading pass (createGiBvhHitShade) keeps
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
 *
 * `penumbraOut` (optional TSL var) collects the ANALYTIC PENUMBRA HALF-WIDTH
 * in metres when the bundle's trace advertises `withPenumbra` — the emitter
 * shadow pass's second target (2026-08-13). It is written INSIDE the same
 * gates as the shadow, so a slot that never traced keeps 0 = no blur, and it
 * carries the same grazing fade: a shadow faded back to 1 must not leave a
 * blur radius behind for the wide pass to smear.
 */
export function emitterSlotShadow(params, slot, P, N, samplePoint, penumbraOut = null, targetJitter = null) {
  const center = vec3(slot.center);
  const toEmitter = center.sub(P).toVar();
  const dist = toEmitter.length().max(1e-3).toVar();
  const dirToEmitter = toEmitter.div(dist).toVar();
  // ── §14 Q7: AREA SAMPLING ──────────────────────────────────────────────────
  // With `targetJitter` (vec2 of per-pixel, per-frame IGN from the emitter
  // shadow pass) the RAY aims at a jittered point on the source's disc
  // instead of its centre, and the temporal chain's EMA converges the
  // stochastic hit/miss to the true AREA VISIBILITY — penumbra from physics,
  // where before it was a screen-space blur of one binary centre ray. Only
  // the ray moves: cosθ, the grazing fade, k and the luma admission stay on
  // the centre so energy and gating are jitter-free. sqrt = uniform over the
  // disc; ×0.8 keeps the target inside the fitted shape of a box emitter.
  const jitterOn = targetJitter != null;
  let rayDir = dirToEmitter;
  let rayDist = dist;
  if (jitterOn) {
    const up = select(dirToEmitter.y.abs().greaterThan(0.9), vec3(1, 0, 0), vec3(0, 1, 0));
    const t1 = cross(dirToEmitter, up).normalize().toVar();
    const t2 = cross(dirToEmitter, t1).toVar();
    const jr = targetJitter.x.sqrt().mul(0.8).mul(float(slot.radius));
    const ja = targetJitter.y.mul(Math.PI * 2);
    const toTarget = toEmitter
      .add(t1.mul(ja.cos()).add(t2.mul(ja.sin())).mul(jr))
      .toVar();
    rayDist = toTarget.length().max(1e-3).toVar();
    rayDir = toTarget.div(rayDist).toVar();
  }
  const cosTheta = dirToEmitter.dot(N).toVar();
  const sinR = float(slot.radius).div(dist).clamp(0, 1).toVar();
  const emitterLum = vec3(slot.color)
    .mul(emitterSlotFactor(slot, P, N, cosTheta, sinR))
    .dot(vec3(0.2126, 0.7152, 0.0722))
    .toVar();
  const shadow = float(1).toVar();
  // `traceCutoffScale` (default 1 = trace everything the show-fade shows)
  // raises ONLY the trace admission, not the contribution fade. The resolve's
  // reflection-hit path sets it (see createGiBvhHitShade): a hit
  // pixel runs this whole march inline per slot, and tracing every pixel
  // within a lamp's full 1/d² reach there measured 1.7 → 60 ms of resolve at
  // 3 emitters. Slots gated out here keep shadow = 1 — dim light renders
  // UNSHADOWED rather than not at all, a deliberate, BOUNDED exception to the
  // "too dim to trace ⇒ too dim to show" rule above: the leak is capped at
  // scale × cutoff luma, and only inside reflections.
  const traceCut = emitterCutoff(params) * (params.traceCutoffScale ?? 1);
  If(
    slot.radius.greaterThan(0.001)
      .and(cosTheta.greaterThan(0.05))
      .and(dist.lessThan(params.shadowRange))
      .and(emitterLum.greaterThan(traceCut)),
    () => {
      // k = distance / emitter angular radius encodes the light's angular
      // size: bigger/closer emitter → softer. Floor 1.2 so a large area
      // lamp close to the receiver keeps a wide, soft penumbra.
      const k = dist.div(float(emitterAngularRadius(slot)).max(0.05)).clamp(1.2, 48);
      // Ray cap at the emitter's actual SURFACE (slab entry for boxes —
      // the bounding sphere of an elongated lamp stopped the ray well
      // short of its face, exempting anything hugging it from occluding).
      // `maxTraceDistance` (optional, metres) additionally caps the MARCH
      // LENGTH from the receiver. The resolve's reflection-hit path sets it:
      // `traceCutoffScale` alone is an absolute-luma gate, so a STRENGTH-100
      // lamp keeps its whole 1/d² reach earning full-length marches (their
      // Sponza: resolve 60→50ms only — the gate never fired indoors). A
      // length cap bounds the per-march cost independent of emitter strength
      // and keeps near-receiver occlusion — the part that reads as shadow in
      // a reflection — exact; occluders beyond the cap stop occluding (soft,
      // spatially plausible leak, reflections only).
      const rawMaxT = emitterSurfaceT(slot, samplePoint, rayDir, rayDist).sub(params.shadowMargin).max(0);
      const marchCap = Number(params.maxTraceDistance);
      const maxT = Number.isFinite(marchCap) && marchCap > 0 ? rawMaxT.min(marchCap).toVar() : rawMaxT;
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
        // ANALYTIC-PENUMBRA ARM: the trace returns vec2(visibility, penumbra
        // half-width in metres) instead of a bare visibility, because the
        // blocker distance it needs for the width is a by-product of the hit
        // it already computes. `dist` and the slot's angular radius ride
        // along — `k` cannot stand in for them, it is CLAMPED to [1.2, 48]
        // and the clamp is exactly where a big close lamp lives.
        const traced = params.recordShadowTrace
          ? params.recordShadowTrace(
              P, N, rayDir, maxT, k, cosTheta,
              rayDist, float(emitterAngularRadius(slot)).max(1e-3),
              // §11.40: the caller's static visibility cache entry, or null.
              params.staticCache ?? null,
            )
          : params.shadowTraceFn(
              samplePoint, rayDir, maxT, k, cosTheta,
              center, exRadius, exBox,
            );
        // Grazing fade: with the ray nearly parallel to the receiver plane
        // the trace hugs the surface's own field and flickers in terraced
        // rings around the emitter. E already carries cosθ, so at grazing
        // angles the shadow contributes nothing but rings.
        const graze = smoothstep(0.05, 0.2, cosTheta).toVar();
        // ── §13.10: THE ADMISSION GATES MUST FADE THE WAY THE GRAZING ONE
        // DOES, AND TWO OF THEM DID NOT ────────────────────────────────────
        //
        // `cosTheta > 0.05` is a hard branch condition that is then RAMPED by
        // `graze`, so nothing steps at it. Its two neighbours in the same
        // condition — the luma admission and the range cap — had no such ramp,
        // and both are surfaces that cut straight across open floor:
        //
        //   · LUMA. The contribution fade in `emitterDirectAt` is
        //     `smoothstep(cutD/3, cutD, lum)`, so at `lum == cutD` the emitter
        //     is at FULL strength — and that is exactly where the trace
        //     admission flipped. One texel inside: shadowed. One texel
        //     outside: `shadow = 1`. A 100% step in that emitter's
        //     contribution, along its own iso-luminance surface, which meets
        //     the floor as a smooth CURVE. With emitters of different colours
        //     each curve carries its own hue, which is the user's "weird seams
        //     between the lights" (2026-08-19). Bisected to here: turning
        //     emitter shadows off cleaned the floor completely while the wide
        //     passes, the probe spacing, the tile cut's feather and its tail
        //     compensation each came back negative.
        //   · RANGE. `dist < shadowRange` is the same shape — a sphere around
        //     the emitter, and a big room can reach it.
        //
        // The fix costs NOTHING: keep the admission set exactly as it was and
        // ramp the traced shadow IN over the band just above each threshold,
        // so the traced side arrives at `1` — which is what the untraced side
        // already returns.
        //
        // §14 Q4: the LUMA half of this ramp is retired — the contribution
        // fade in `emitterDirectAt` now reaches ZERO at the admission
        // threshold, so there is no step there to hide (ramping the shadow
        // out over the same band would only re-open a half-shadowed leak in
        // it). The RANGE half ships DEFAULT ON: `dist ≥ shadowRange` snaps
        // the traced value to 1 on a sphere a big room can reach, and
        // contribution is NOT zero there for a strong emitter — the ramp
        // over [0.85, 1]·shadowRange is the only thing between that sphere
        // and a visible circle on the floor. `__giEmitterShadowGateFade =
        // false` restores the hard gate for A/B.
        if (globalThis.__giEmitterShadowGateFade !== false) {
          graze.mulAssign(
            float(1).sub(smoothstep(
              float(params.shadowRange).mul(0.85),
              float(params.shadowRange),
              dist,
            )),
          );
        }
        if (params.recordShadowTrace?.withPenumbra === true) {
          const pair = vec2(traced).toVar();
          shadow.assign(mix(float(1), pair.x, graze));
          if (penumbraOut) penumbraOut.assign(pair.y.mul(graze));
        } else {
          shadow.assign(mix(float(1), traced, graze));
        }
      });
    },
  );
  return shadow;
}

// ── THE PUNCTUAL LIGHT MODEL, AND IT IS three's, TERM FOR TERM ─────────────
//
// Five call sites shade a GI hit against the engine's light slots — this file's
// `analyticDirectAt` (unrolled), its mirror-hit block inside
// `GICascadeLightNode.setup`, `analyticDirectAtRolled`, and `srcShade.js`'s
// `lightTermsAt`. Each of them carried its OWN copy of the attenuation, and the
// copies were a hardcoded inverse-square with a 1 m denominator floor. That was
// wrong twice over against the renderer the GI has to agree with:
//
//   · `decay` never arrived. three evaluates `1 / max(d^decay, 0.01)`
//     (`LightUtils.getDistanceAttenuation`); GI evaluated `1 / max(d², 1)`. A
//     lamp authored at any decay but 2 lit its bounce on a different curve from
//     its own direct light.
//   · the near-field floor differed by 100x. Inside a metre of a point light
//     three's attenuation keeps climbing to 100 and GI's stopped at 1 — a bulb
//     0.3 m off a ceiling delivered 11.1 to the raster and 1.0 to the bounce.
//
// And the cone never existed at all, so a spot light had no way into the slots:
// `GISystem#collectLightObjects` did not collect one, because a slot that
// ignores the cone would light a full sphere from it.
//
// So the model lives HERE, once, and every consumer calls it. Two terms:
//
//   DISTANCE  `getDistanceAttenuation` verbatim — the Frostbite windowed
//             falloff, `decay` as the exponent, the `distance` cutoff as the
//             window. Directional slots keep exactly 1 (`mix` on `isDir`).
//   CONE      `SpotLightNode.getSpotAttenuation` verbatim —
//             `smoothstep(cos(angle), cos(angle·(1−penumbra)), cos(θ))`.
//
// ⚠ THE CONE TERM IS BRANCHLESS, AND THAT IS WHAT MAKES IT FREE FOR EVERY
// OTHER KIND. A directional or point slot publishes `coneCos = -2`,
// `penumbraCos = -1` (see GISystem's `#updateLightUniforms`): every cosine a
// real direction can produce is already at or past the upper edge, so the
// smoothstep is exactly 1 and the same expression serves all three kinds
// without a uniform read deciding which code runs. Which kind a slot holds
// stays a RUNTIME fact — R11: adding a light updates uniforms and never
// recompiles.
//
// Slots that predate these fields (the `gi-src-shade.html` fixture builds slot
// objects by hand) simply omit them, and the terms they gate compile out —
// `decay` absent reads as 2, `coneCos` absent emits no cone at all.

/**
 * three's punctual attenuation for one GI light slot: distance falloff times
 * the spot cone. 1 for a directional slot, by construction.
 *
 * @param {object} slot a light slot (uniforms, or picked vars from the rolled
 *   loop — every field is read through `float()`/`vec3()`, so either works)
 * @param {*} dirTo unit direction from the receiver TOWARD the light
 * @param {*} dist distance to the light (ignored for a directional slot)
 * @param {*} isDir the slot's `kind` as a float node (1 = directional)
 */
export function punctualAttenuation(slot, dirTo, dist, isDir) {
  // `pow(d, decay)`, not `d·d`: `decay` is three's exponent and the engine
  // exposes it per light (0 = no falloff at all, which is what `d^0 = 1` gives
  // here). Floored at three's own 0.01, NOT at 1 — see the header.
  const decay = slot.decay != null ? float(slot.decay) : float(2);
  const atten = mix(float(1).div(dist.pow(decay).max(0.01)), float(1), isDir).toVar();
  // three's PointLight/SpotLight `distance` cutoff (0 = infinite). GI must die
  // exactly where the renderer's own direct light does, or the mismatch reads
  // as light being "cut" at a circle.
  if (slot.range) {
    const range = float(slot.range);
    const ratio = dist.div(range.max(1e-4)).clamp(0, 1);
    const r2 = ratio.mul(ratio);
    const win = r2.mul(r2).oneMinus().clamp(0, 1);
    atten.mulAssign(mix(float(1), win.mul(win), step(1e-3, range).mul(isDir.oneMinus())));
  }
  if (slot.coneCos != null) {
    // `axis` points FROM the light toward its target and `dirTo` points from
    // the receiver toward the light, so the angle cosine three takes as
    // `dot(lightDirection, spotAxis)` is the dot against `-dirTo` here.
    atten.mulAssign(smoothstep(
      float(slot.coneCos),
      float(slot.penumbraCos),
      dirTo.negate().dot(vec3(slot.axis)),
    ));
  }
  return atten;
}

/**
 * A slot's CONE term alone at a world point, or null when the slot carries no
 * cone (every kind but spot, and slots built before the fields existed).
 *
 * For gating work that a spot cannot pay for: outside the cone the light is
 * exactly zero, so its shadow — the most expensive per-pixel trace this module
 * runs — has nothing to occlude. The screen chain's `createGiLightShadowPass`
 * hangs its whole slot block on this; a null means "no cone, gate nothing" and
 * leaves that block's condition byte-identical to before.
 */
export function spotReachAt(slot, P) {
  // Presence, not truthiness — `coneCos` is 0 for a 90° cone (see
  // `punctualAttenuation`'s own guard).
  if (slot.coneCos == null) return null;
  const isDir = float(slot.kind);
  const rel = vec3(slot.vector).sub(P);
  const dirTo = mix(rel.div(rel.length().max(1e-4)), vec3(slot.vector), isDir);
  return smoothstep(
    float(slot.coneCos),
    float(slot.penumbraCos),
    dirTo.negate().dot(vec3(slot.axis)),
  );
}

/**
 * The whole punctual bundle at a world point: which way the light is, how far,
 * and what fraction of it survives the falloff and the cone.
 *
 * `vector` holds the world POSITION for a point/spot slot and the normalized
 * direction TOWARD the light for a directional one; `kind` selects between them
 * (the convention `cascadeGather`, `analyticDirectAt` and the screen chain all
 * share — reusing it rather than re-deriving is what keeps SRC's hits agreeing
 * with the screen chain's pixels).
 */
/**
 * THE MAPPED SUN'S VISIBILITY AT A WORLD POINT — a texel, not a ray.
 *
 * three's own shadow coordinate, replicated exactly (`ShadowNode`'s
 * `setupShadowCoord`): `pos = M × (P + n·normalBias)`, `/w`, y flipped, z ±
 * bias by the depth convention, in-frustum when uv ∈ [0,1] and z ∈ [0,1]. The
 * map is read with `textureLoad` — a comparison sampler is fragment-only — and
 * compared with the same sense the material's sampler uses (LessEqual, or
 * GreaterEqual under reversed depth). Cascades run near → far and the first
 * one containing the point wins.
 *
 * ⭐ RETURNS −1 WHEN NO CASCADE COVERS THE POINT, and that is the contract:
 * the caller must fall back to whatever it did before rather than treating −1
 * as "shadowed". Every consumer clamps, so a silent −1 would read as black.
 *
 * ── WHY THIS LIVES HERE (2026-09-09) ────────────────────────────────────────
 * It was written inside `srcShade.js`'s kernel builder, closed over that
 * scope's `P`/`n`, and therefore unreachable from the reflection hit shade —
 * which was tracing the static BVH for the SAME sun's visibility instead.
 * Measured on Sponza at ultra: that BVH pair is **`bvhHitShade` 3.57 ms
 * against 1.22 ms without it**, ~19 % of GI's whole budget, spent computing a
 * second opinion about a shadow the frame had already rasterised into a
 * 4096² map. One definition, two consumers — the same rule the hit shading
 * formula itself follows.
 *
 * @param {object|null} sunShadow  GISystem's per-frame bundle (matrices,
 *   biases, normalBiases, sizes, count, slot, reversed, `bind(c, texel)`).
 * @param {*} P  world position node
 * @param {*} n  world normal node (the normal bias is applied along it)
 * @returns {*|null} a float node in {0, 1}, or −1 outside every cascade;
 *   null when there is no bundle at all (the caller keeps its old path).
 */
export function sunShadowVisibilityAt(sunShadow, P, n) {
  if (!sunShadow) return null;
  const v = float(-1).toVar();
  const comp = ["x", "y", "z", "w"];
  for (let c = 0; c < sunShadow.matrices.length; c++) {
    If(v.lessThan(0).and(int(c).lessThan(sunShadow.count)), () => {
      const nb = sunShadow.normalBiases[comp[c]];
      const bias = sunShadow.biases[comp[c]];
      const size = sunShadow.sizes[comp[c]];
      const pos = sunShadow.matrices[c].mul(vec4(P.add(n.mul(nb)), 1)).toVar();
      const coord = pos.xyz.div(pos.w).toVar();
      const u = coord.x.toVar();
      const w = float(1).sub(coord.y).toVar();
      const z = (sunShadow.reversed ? coord.z.sub(bias) : coord.z.add(bias)).toVar();
      const inside = u.greaterThanEqual(0).and(u.lessThanEqual(1))
        .and(w.greaterThanEqual(0)).and(w.lessThanEqual(1))
        .and(z.greaterThanEqual(0)).and(z.lessThanEqual(1));
      If(inside, () => {
        const texel = ivec2(
          u.mul(size).clamp(0, size.sub(1)),
          w.mul(size).clamp(0, size.sub(1)),
        );
        const d = float(sunShadow.bind(c, texel)).toVar();
        v.assign(sunShadow.reversed
          ? select(z.greaterThanEqual(d), float(1), float(0))
          : select(z.lessThanEqual(d), float(1), float(0)));
      });
    });
  }
  return v;
}

export function punctualTermsAt(slot, P) {
  const isDir = float(slot.kind).toVar();
  const rel = vec3(slot.vector).sub(P).toVar();
  const dist = rel.length().max(1e-4).toVar();
  const dirTo = mix(rel.div(dist), vec3(slot.vector), isDir).toVar();
  return { isDir, dirTo, dist, atten: punctualAttenuation(slot, dirTo, dist, isDir) };
}

/**
 * Analytic (directional/point/spot) direct irradiance at an arbitrary world
 * point, from the shared GI light slots. UNSHADOWED by design.
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
/**
 * @param {boolean} [oneSided] — CLAMP the cosine instead of taking its absolute
 *   value. Default false, which keeps every existing caller byte-identical.
 *
 * ⚠ THE DEFAULT IS RIGHT FOR A FIELD CELL AND WRONG FOR A HIT, and the
 * distinction is already written down in this repo — `srcShade.js`'s
 * `lightTermsAt` header (§12.26.4):
 *
 *   "THE COSINE IS CLAMPED HERE, NOT ABSOLUTE. `analyticDirectAt` takes
 *    dot(dirTo, N).abs() because it shades a FIELD CELL, which has no definite
 *    side — a cell straddling a wall must light from either. A hit has a side:
 *    the normal was face-forwarded against the ray one line earlier, so abs()
 *    here would light the back of every wall from a lamp in front of it."
 *
 * `createGiBvhHitShade` shades a HIT — it face-forwards `nFace` against the
 * reflected ray and then called this function with the field-cell convention.
 * The consequence is the user's report: every reflected surface whose visible
 * face points AWAY from the sun received the sun's FULL irradiance, where the
 * same surface rendered directly receives exactly zero (three's `max(0, N·L)`
 * times its shadow map). That is roughly half of every reflected scene lit from
 * the wrong side — "materials that are very reflective ignore lighting,
 * appearing too bright", and at roughness 0.2 `exactWeight ~ 0.93`, so that
 * image replaces the surface response almost wholesale.
 */
export function analyticDirectAt(lightSlots, P, N, shadowFn = null, oneSided = false, options = null) {
  // `{ rolled: true }` — one traced descent per program instead of one per
  // slot; see analyticDirectAtRolled at the end of this file.
  if (options?.rolled && globalThis.__giRolledAnalytic !== false && shadowFn && lightSlots.length > 1) {
    return analyticDirectAtRolled(lightSlots, P, N, shadowFn, oneSided);
  }
  const total = vec3(0).toVar();
  for (const [slotIndex, slot] of lightSlots.entries()) {
    If(slot.active.greaterThan(0.5), () => {
      // Direction, distance and three's falloff+cone, from the one model every
      // GI consumer shares (see `punctualAttenuation`'s header).
      const { isDir, dirTo, dist: pointDist, atten } = punctualTermsAt(slot, P);
      // See the `oneSided` note on the signature: `.abs()` is the FIELD-CELL
      // convention (a cell straddling a wall must light from either side);
      // `.max(0)` is the SURFACE convention, and a face-forwarded hit normal is
      // a surface. Same expression `srcShade.js` uses for its own hits.
      const cosH = (oneSided ? dirTo.dot(N).max(0) : dirTo.dot(N).abs()).toVar();
      // `shadowFn` (optional, 2026-08-21 — reflection-hit realism): a caller
      // that can afford a visibility march supplies it; the resolve's hit
      // path passes an occupancy-cone closure so a reflected sunlit wall
      // carries its shadow instead of full flat light. Absent → this graph
      // is byte-identical to before the parameter existed.
      const lit = vec3(slot.color).mul(atten).mul(cosH);
      // 5th arg = WHICH SLOT (2026-09-09). A shadowFn that can answer more
      // cheaply for one particular light — the reflection hit shade reading
      // the mapped sun's shadow map instead of tracing the BVH — cannot tell
      // which light it is being asked about without it. Extra arguments are
      // ignored by every callback that does not take them, so this is additive.
      total.addAssign(shadowFn ? lit.mul(float(shadowFn(dirTo, isDir, pointDist, cosH, int(slotIndex))).clamp(0, 1)) : lit);
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
    // §11.35: the AO term at AO resolution (ultra/high: the viewport's), a
    // PERSISTENT TextureNode like the three above (a 1×1 white placeholder
    // while the term rides the resolve instead), and its live enable uniform.
    // Sampled bilinearly at the pixel's own GI screen UV and multiplied into
    // the deferred irradiance — the sharp half of "the AO is blurry".
    this.giAoNode = null;
    this.giAoActiveU = null;
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
    // Box-projected reflection probes (§14 unit R-B): { node, slots } — the
    // octahedral atlas texture node plus the per-slot box uniforms
    // (reflectionProbes.js). Set by GISystem only when the scene actually has
    // ReflectionProbe components (probe EXISTENCE is in the structural
    // signature), so a probe-less scene compiles none of this.
    this.giProbes = null;
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
    // Live-tunable without recompiles. In the RENDER group (§11.32): a
    // uniform in the default object group lives in each object's own buffer,
    // which a `static` object never re-uploads — the shared group's buffer is
    // uploaded by the first refreshed object of the render and read by all.
    this.intensityUniform = uniform(1).setGroup(renderGroup);
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
    // Transparent particles do not write the opaque gbuffer. Its deferred
    // irradiance/AO belongs to the wall behind them, even when sampled at the
    // same screen coordinate. A directional world-space cache samples the
    // active SRC field in compute; optional reflection probes are a fallback.
    // Texture reads only: keep per-particle state out of GI storage budgets.
    if (builder.material?.userData?.giParticle || builder.material?.userData?.giWater) {
      if (light.vfxIrradiance) {
        builder.context.irradiance.addAssign(light.vfxIrradiance(samplePoint, N).mul(light.intensityUniform));
      } else if (light.giProbes) {
        const probe = sampleReflectionProbes(light.giProbes, positionWorld, N, float(1));
        builder.context.irradiance.addAssign(vec3(probe.rgb).mul(Math.PI).mul(probe.weight).mul(light.intensityUniform));
      }
      // ⛔⛔ WATER MUST RETURN HERE TOO, AND THE REASON IS A HARD LIMIT.
      //
      // Letting water fall through to the radiance block below gives it the
      // traced reflection it wants — and binds every texture that block needs
      // on top of the ones the water material already has: the medium's two
      // surface maps, its two caustic maps, the depth texture the foam reads,
      // and the shader graph's own. That came to **17 sampled textures in the
      // fragment stage against a portable limit of 16**, so the Water pipeline
      // failed to create at all and the surface vanished from the scene:
      //
      //   "The number of sampled textures (17) in the Fragment stage exceeds
      //    the maximum per-stage limit (16)" → renderPipeline_Water_167 invalid
      //
      // A water reflection has to come from somewhere that is not a per-material
      // texture binding — the screen-space pass, or a slot the water already
      // holds — and until it does, this early return is load-bearing.
      return;
    }
    // DEFERRED PATH (the normal one — see giScreen.js): the gather and the
    // emitter shadow traces already ran once per screen pixel, so a material
    // reads the answer instead of recomputing it. This is what keeps material
    // shaders small enough for the driver to compile quickly, and what makes
    // a GI rebuild leave material code untouched (no recompile wave).
    const deferred = light.giIrradianceNode != null;
    // ── GI TEXTURES ARE KEYED TO THE RESOLVE CAMERA, NOT TO WHOEVER IS
    // RENDERING (2026-08-22, the planar-mirror "double reflection"). Every
    // deferred GI texture (irradiance, packed emitter shadows, glossy
    // radiance, the exact-reflection set) was resolved for the MAIN camera's
    // pixels. This material also renders in NESTED views — the planar
    // reflector's mirrored pass — where `screenUV` is the NESTED camera's
    // pixel: sampling by it stamped the main view's irradiance IMAGE (sun
    // pools, the lit character) across the mirrored geometry as a ghost
    // second reflection. Projecting the WORLD POSITION through the resolve
    // camera's VP samples the texel that holds THIS point's GI in every
    // view; in the main render it reproduces screenUV exactly (same camera,
    // same interpolants). Points the main view cannot see land on a texel
    // holding some OTHER surface's GI — the position-validated bilateral
    // below rejects exactly those taps (its gbuffer-position check) and
    // falls to its darkest-tap answer: dim, never a ghost.
    const giUV = light.giViewProj
      ? (() => {
          const clip = vec4(light.giViewProj.mul(vec4(positionWorld, 1)));
          const w = clip.w.max(1e-4);
          return vec2(
            clip.x.div(w).mul(0.5).add(0.5),
            float(0.5).sub(clip.y.div(w).mul(0.5)),
          ).clamp(0, 1);
        })()
      : screenUV;
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
        ? (texNode, texel = light.giScreenTexel, nestedFallback = null) => {
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
              // Texel size of the texture being sampled — NOT always the
              // shadow channel's: the emitter pack is a smaller buffer
              // (emitterShadowScale × shadow size), and ±0.5 shadow-texels
              // there is ±0.35 emitter-texels — the four taps collapse onto
              // one texel and the bilateral stops discriminating (found
              // 2026-08-13). Callers pass the right texel; the default keeps
              // every resolve-sized texture exactly as before.
              const uv = giUV.add(vec2(texel).mul(vec2(dx, dy)));
              const v = vec4(texNode.sample(uv)).toVar();
              const g = light.giPositionNode.sample(uv);
              const d = g.xyz.sub(positionWorld).length();
              const w = select(g.w.greaterThan(0.5).and(d.lessThan(threshold)), float(1).div(d.add(weightEps)), float(0)).toVar();
              return { v, w };
            });
            const wSum = taps.reduce((a, t) => a.add(t.w), float(0));
            const blend = taps.reduce((a, t) => a.add(t.v.mul(t.w)), vec4(0)).div(wSum.max(1e-4));
            const darkest = taps.reduce((a, t) => a.min(t.v), vec4(1e9));
            // Full rejection means every tap holds some OTHER surface's GI.
            // In the MAIN view that is a half-res silhouette rim, and the
            // darkest foreign tap is the least-wrong answer ("a dark error
            // is a dim pixel"). In a NESTED render (the planar reflector's
            // mirrored pass — `giNestedView` flips per render) most of the
            // image is main-view-OCCLUDED — a wall mirror shows the room
            // BEHIND the camera — and the darkest foreign tap stamped a
            // ghost while plain zero blacked the whole mirrored room
            // ("only one reflection now, but not GIed"). Each call site
            // passes the least-wrong WORLD-SPACE stand-in instead: the
            // reflection-probe atlas for irradiance (room-correct, blurry),
            // 1 for shadow factors (unshadowed beats black).
            const rejected = light.giNestedView
              ? select(float(light.giNestedView).greaterThan(0.5), nestedFallback ?? vec4(0), darkest)
              : darkest;
            const resolved = select(wSum.greaterThan(1e-4), blend, rejected);
            // NESTED RENDERS TAKE THE STAND-IN EVERYWHERE, not just on full
            // rejection (2026-08-22, "not shadows — they move as I orbit the
            // camera"): a validated tap in a mirror is CORRECT but PARTIAL,
            // and which mirrored points validate is a function of the MAIN
            // camera — so the exact-GI regions slid across the mirrored
            // floor against the probe-fallback regions as the user orbited,
            // reading as camera-dependent smudges. A mirror wants STABLE
            // over locally-exact: where a world-space stand-in exists, it
            // wins the whole nested image (uniform tone, no moving seams);
            // direct sun/emitter terms still carry the exact detail there.
            return light.giNestedView && nestedFallback
              ? select(float(light.giNestedView).greaterThan(0.5), nestedFallback, resolved)
              : resolved;
          }
        : null;
    // The nested-render stand-in for irradiance: the probe atlas sampled
    // along the surface NORMAL at roughness 1 — which the level ladder maps
    // to the atlas's COSINE-HEMISPHERE tile (E/π by construction, see
    // REFL_PROBE_LEVEL_CONES), so ×π is exactly irradiance. Before that
    // tile existed this hit the 26° cone level, and π × a narrow cone along
    // N is NOT irradiance — it misses the bright sunlit floor and returns
    // the saturated hue of whatever faces the surface ("incorrect
    // reflections in the perfect mirror": swirly green walls, red-brown
    // floor). Compiled only when the scene has probes; without them the
    // nested fallback stays zero (dim mirror, never a ghost).
    const irrNestedFallback = light.giProbes
      ? (() => {
          const p = sampleReflectionProbes(light.giProbes, positionWorld, N, float(1));
          return vec4(vec3(p.rgb).mul(Math.PI).mul(p.weight), 1);
        })()
      : null;
    const irradiance = deferred
      ? vec3(bilateral ? bilateral(light.giIrradianceNode, light.giScreenTexel, irrNestedFallback) : light.giIrradianceNode.sample(giUV)).toVar()
      : vec3(light.gatherFn(samplePoint, N, cameraPosition.sub(positionWorld).normalize())).mul(light.intensityUniform);
    // §11.35: the AO term at its own resolution. It multiplies the WHOLE
    // deferred irradiance (diffuse indirect + emitter direct, both screen-
    // space terms of the same texel); the sun's analytic direct term below
    // is untouched, as it was when the resolve applied AO.
    if (deferred && light.giAoNode) {
      const aoTex = vec4(light.giAoNode.sample(giUV)).x.clamp(0, 1);
      const aoOn = light.giAoActiveU ? float(light.giAoActiveU).clamp(0, 1) : float(1);
      irradiance.mulAssign(mix(float(1), aoTex, aoOn));
    }
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
    // ROLLED GLOW (2026-09-02): the specular glow below runs its per-slot
    // body ONCE inside a GPU loop over the slot table instead of four
    // JS-unrolled copies (see emitterGlowRolled). The rolled body derives
    // each slot's geometry from the picked centre, so the per-slot vars this
    // block used to hoist are not emitted on that arm.
    const rolledGlow = globalThis.__giRolledGlow !== false && (light.emitterSlots?.length ?? 0) > 1;
    if (deferred) {
      // Emitter direct + its shadow are already in the irradiance texture.
      // The specular glow below still needs each slot's geometry and its
      // shadow factor, so the resolve pass packs the four shadows into one
      // RGBA texture — a fetch instead of up to four sphere traces per pixel.
      if (light.emitterSlots?.length && light.giEmitterShadowNode) {
        // Same bilateral as the irradiance above — packed per-emitter shadow
        // factors smear across silhouettes identically, and min-per-channel
        // as the no-tap fallback is exactly "darkest shadow wins".
        const packed = (bilateral
          ? bilateral(light.giEmitterShadowNode, light.giEmitterShadowTexel ?? light.giScreenTexel, vec4(1))
          : light.giEmitterShadowNode.sample(giUV)).toVar();
        const channels = [packed.x, packed.y, packed.z, packed.w];
        light.emitterSlots.forEach((slot, index) => {
          // §12.70 W4b: under the tile cut the packed channels are keyed to
          // each pixel's TILE list, not to these global seats — sampling
          // them here would occlude one lamp's glow with another lamp's
          // shadow. The glow goes UNSHADOWED on that arm (a near-emitter
          // effect the seats still cover); re-keying the material path is
          // W5's business if it ever shows.
          const shadow = light.emitterTileKeyed ? float(1) : (channels[index] ?? float(1));
          if (rolledGlow) {
            emitterData.push({ slot, shadow });
            return;
          }
          const toEmitter = vec3(slot.center).sub(positionWorld).toVar();
          const dist = toEmitter.length().max(1e-3).toVar();
          emitterData.push({
            slot,
            shadow,
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
        ? vec3(light.giRadianceNode.sample(giUV))
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
      // BOX-PROJECTED REFLECTION PROBES (§14 unit R-B) — the world-space
      // middle layer. Inside a probe's box this REPLACES the cascade lookup
      // (feather-weighted): the probe is the same field-lit world, but
      // parallax-anchored to the room's geometry and angularly sharper than
      // the direction bins. It sits BEFORE the exact-BVH blend below on
      // purpose — where ultra's per-pixel trace resolves a hit, exactness
      // wins over the probe; everywhere else (all lower tiers, miss pixels,
      // roughness past the mirror gate) the probe is the answer. Outside
      // every box the weight is 0 and this whole term is inert.
      //
      // NESTED-RENDER ARBITRATION (2026-08-22, "incorrect reflections in
      // the perfect mirror"): every screen-keyed reflection source in this
      // chain — the deferred cascade texture above, the exact-BVH blend and
      // the mirror trace below — holds the MAIN view's data, and inside a
      // planar reflector's mirrored render it stamps that data as garbage
      // (the chrome box seen in the mirror showed swirls). In nested views
      // the probes are the ONLY reflection source: their weight is forced
      // to 1 (probe.rgb is 0 outside every box — dim beats ghost), and the
      // exact/mirror gates multiply to 0 below. Without probes the whole
      // directional term is killed in nested views for the same reason.
      const nested = light.giNestedView ? float(light.giNestedView).clamp(0, 1) : float(0);
      const nestedKill = float(1).sub(nested);
      if (light.giProbes) {
        const probe = sampleReflectionProbes(light.giProbes, positionWorld, reflected, roughness);
        directional = mix(directional, probe.rgb, probe.weight.max(nested));
      } else {
        directional = vec3(directional).mul(nestedKill);
      }
      // FAST EXACT PATH. The shared BVH pass already traced the reflected
      // ray and texture-sampled the hit triangle. Blend that cached hit color
      // over the deferred directional cascade result for mirror-ish pixels.
      // This replaces the old per-material hit reconstruction/SDF/shadow
      // graph (tens of seconds to compile) with two texture reads and a mix.
      // Shared confidence for every delta-like reflection consumer. A true
      // mirror stays at 1; the moderately rough tail hands off to the broad
      // field, and the finite prefilter may reduce it further below.
      const exactFidelity = float(1).sub(smoothstep(
        GI_EXACT_TAIL_FULL,
        GI_EXACT_TAIL_ZERO,
        roughness,
      )).toVar();
      if (light.bvhReflectColorTexture && canMirror) {
        // Materialise the broad answer once. Invalid exact-filter taps use this
        // already-bound, already-sampled field value; keeping it as a local var
        // prevents the 13-tap loop from cloning the gather graph or its reads.
        const broadDirectional = vec3(directional).toVar();
        directional = broadDirectional;
        const exactHit = light.bvhReflectColorTexture.sample(giUV);
        // ── THE ROUGHNESS PREFILTER (2026-08-22) ────────────────────────────
        //
        // USER REPORT: "when roughness or metalness get less mirror light, I
        // need it smoothed out, more like in real life, because currently it
        // just gets messy as hell."
        //
        // The exact arm traces ONE mirror ray per pixel no matter what the
        // material's roughness is. So a roughness-0.3 metal got a pin-SHARP
        // reflection at HALF weight (`exactWeight`'s 0.45→0.15 ramp),
        // crossfaded against the probe's own differently-blurred image of the
        // same room: two disagreeing pictures interleaved per pixel, which is
        // exactly what reads as mess. A real glossy surface integrates a LOBE,
        // and a lobe that widens with roughness is a BLUR — so blur it, and
        // the crossfade lands between two SMOOTH images instead.
        //
        // WHY IN THE MATERIAL AND NOT IN A PASS: roughness is a per-material
        // (often per-pixel) quantity no screen-space pass can see — the
        // gbuffer's mirror channel is ONE BIT, written by an override material
        // that by construction cannot read the material it overrides (see
        // createGiGBuffer's mask note). Here the value is exact and the radius
        // can be continuous in it. It also costs no new texture binding, which
        // a prefiltered second target would, on the one shader family that is
        // already the heaviest thing GI compiles.
        //
        // ⚠ THE GATE IS A RADIUS, NOT A COMPILE-TIME ROUGHNESS TEST. Reading
        // `staticRoughnessOf` here to skip the taps for mirrors looks free and
        // is a trap: the shader is CACHED by the roughness BUCKET, so a
        // material edited from 0 to 0.3 stays inside bucket 0, never
        // recompiles, and would keep a build with no prefilter in it — the
        // user's own workflow ("when roughness gets less mirror") is exactly
        // that edit. The taps are always compiled; at roughness ≤0.02 the
        // radius is zero, every tap reads the centre texel and the mean is the
        // centre value, so a true mirror is unchanged pixel-for-pixel.
        // `__giExactPrefilter = false` disables the taps and their coverage
        // ramp; the roughness-only sharp-tail confidence above stays active.
        // `__giExactPrefilterTexels` is the tap disc's CEILING — see the radius
        // derivation below, which took the reach off it.
        const prefilterOn = globalThis.__giExactPrefilter !== false && !!light.giScreenTexel;
        const exactRgb = vec3(exactHit.rgb).toVar();
        if (prefilterOn) {
          // ── THE RADIUS IS THE LOBE'S, NOT A TUNED TEXEL COUNT (2026-08-30) ──
          //
          // USER REPORT, against a reference render for the first time: "could
          // you check our reflections against the path tracer? ours look too
          // flashy and unnatural."
          //
          // The first version of this filter spread the taps over
          // `smoothstep(0.02, 0.45, roughness) * 12` texels — a hand-picked
          // reach, chosen when the only available judge was "does it still look
          // messy". That is the right SHAPE at roughly a TENTH of the right
          // SIZE, and an order of magnitude too narrow is exactly what "flashy"
          // looks like: a glossy wall showing a near-mirror image of the room
          // where a broad, dim sheen belongs. (It also explains the speckle on
          // alpha-tested foliage with no noise term in sight — leaf cards have
          // near-random normals, so the reflected direction and its hit change
          // wildly pixel to pixel, and a delta lobe reports that faithfully
          // where an integrated one would not.)
          //
          // So derive it. A GGX lobe of slope `alpha = roughness^2` covers a
          // world radius of about `alpha * t` at a hit `t` metres along the
          // reflected ray, and a world length at view depth `D` projects to
          // `L * P / (2 * D)` in UV. Taking the hit as roughly as far again as
          // the receiver (`t ~ dist`, and see the STABILITY note below for why
          // NOT the real one) collapses that to `alpha * P / 4`:
          //
          //   roughness 0.15  ->  0.010 UV, inside the cap: a mirror is a mirror
          //   roughness 0.30  ->  0.039 UV  (the old reach gave ~0.018)
          //   roughness 0.45  ->  0.088 UV  (the old reach gave ~0.022)
          //
          // Per axis, and `(P00, P11)` is exactly right for that: P00 = P11 /
          // aspect, so equal UV-scaled offsets land on a circle in PIXELS.
          const projScale = vec2(
            cameraProjectionMatrix.element(0).x,
            cameraProjectionMatrix.element(1).y,
          ).abs();
          const alpha = roughness.mul(roughness);
          const lobeUv = projScale.mul(alpha).mul(0.25).toVar();
          // ⚠ THE CAP IS NOT A QUALITY KNOB, IT IS WHAT 12 TAPS CAN CARRY.
          // Twelve samples on two hex rings resolve a disc only while it stays
          // small; stretched far past that they stop being a blur and become
          // twelve copies of the room — a worse artifact than the sharpness it
          // set out to fix, and a direct breach of the standing "no noise, no
          // edges, no steps" rule. The old hand-tuned reach was measured
          // against exactly that ringing, so it keeps its name and its default
          // and becomes the ceiling rather than the value.
          const reach = Number(globalThis.__giExactPrefilterTexels);
          const texels = float(Number.isFinite(reach) ? reach : 12);
          const capUv = vec2(light.giScreenTexel).mul(texels);
          const step2 = lobeUv.min(capUv).toVar();
          // ── AND NEVER SHOW AN IMAGE SHARPER THAN THE LOBE IT STANDS FOR ────
          //
          // Where the cap binds, the taps cannot represent this material's
          // lobe, and the honest answer is not to show the sharp trace anyway —
          // that IS the flashiness. It is to hand those pixels back to the term
          // that is broad BY CONSTRUCTION: the cascade radiance lookup this
          // blend already mixes against.
          //
          // ⚠ This is NOT §16 R4 again, and the difference is why it is safe
          // where R4 was reverted on sight (see the ladder banner above): R4
          // compiled the directional chain OUT of rough materials, so the light
          // it carried simply vanished and shadowed walls went near-black.
          // Nothing is compiled out here. Both terms stay live and weight only
          // moves BETWEEN two pictures of the same room, one sharp and one
          // blurry.
          //
          // ⛔⛔ EVERY INPUT TO THIS RAMP IS SMOOTH PER PIXEL AND CONSTANT IN
          // TIME, AND THAT IS A HARD REQUIREMENT, NOT AN ACCIDENT. The first
          // cut drove it off `bvhReflectTexture`'s traced hit distance, and the
          // user's first look was "nope, now light flickers, its terrible"
          // (reverted the same hour; plan §2.7d). That texture is NearestFilter
          // BY DESIGN (blending two t's across a silhouette lands on no real
          // surface — see createGiBvhTarget), is written at the prepass STRIDE
          // with block replication, and reads 0 on a miss or a masked pixel —
          // where 0 ramps to FULL fidelity. A steep smoothstep on it switched a
          // large share of the specular on and off per pixel per frame.
          //
          // ⭐⭐ The OLD code read the same `t` and was fine, and the contrast
          // is the whole lesson: it spent it inside `t/(t+dist)` CLAMPED to
          // [0.25, 1] — a bounded multiplier on a BLUR RADIUS, where noise only
          // moves a blur slightly. WHERE A NOISY INPUT IS SPENT DECIDES WHETHER
          // ITS NOISE IS VISIBLE: a radius forgives it, a WEIGHT does not.
          //
          // So this ramp is a function of `roughness` and the projection alone.
          // Both are constant for a given surface point across frames, which
          // makes flicker impossible here by construction rather than by
          // testing. The cost is only that a far reflection no longer smears
          // more than a near one — a second-order refinement, and not one worth
          // buying with a temporal artifact.
          exactFidelity.mulAssign(smoothstep(0.25, 1, capUv.y.div(lobeUv.y.max(1e-6))));
          // Fixed 13-way convolution. Renormalising over valid hits only made a
          // lone bright hit surrounded by real misses stay fully bright — the
          // coherent metallic flash this filter exists to remove. Keep the
          // alpha states distinct, though: -1 is a PROVEN traced miss and gets
          // the broad field; 0 is merely mirror-mask/untraced and must hold the
          // centre sample. Treating mask holes as broad GI made the entire
          // rough reflector look blurry even though no ray had missed.
          const exactCenter = mix(
            broadDirectional,
            vec3(exactHit.rgb),
            step(0.5, exactHit.a),
          ).toVar();
          const sum = vec3(exactCenter).toVar();
          // Two hexagonal rings, the inner one rotated 30° — 12 taps that
          // cover the disc evenly enough that no rotation hash is needed (a
          // per-pixel rotation would need a temporal filter to stop crawling;
          // a fixed pattern needs none, the same trade the AO pass records).
          const RINGS = [
            [1, [[1, 0], [0.5, 0.866], [-0.5, 0.866], [-1, 0], [-0.5, -0.866], [0.5, -0.866]]],
            [0.5, [[0.866, 0.5], [0, 1], [-0.866, 0.5], [-0.866, -0.5], [0, -1], [0.866, -0.5]]],
          ];
          // Do not pay twelve redundant texture reads at either endpoint.
          // For r <= .02 the footprint radius is zero, so every ring tap is
          // byte-for-byte the centre sample already in `sum`. For r >= the
          // exact-tail cutoff (or where the footprint cap reduced fidelity to
          // zero), `exactWeight` below is zero and this filtered value cannot
          // affect the image. This is a dynamic branch because roughness is
          // commonly texture-driven; making it a material bucket would go
          // stale after an edit and would miss mixed roughness maps.
          If(roughness.greaterThan(0.02).and(exactFidelity.greaterThan(0)), () => {
            for (const [scale, ring] of RINGS) {
              for (const [ox, oy] of ring) {
                const uv = giUV.add(vec2(step2.x.mul(ox * scale), step2.y.mul(oy * scale)));
                const tap = light.bvhReflectColorTexture.sample(uv);
                // hit (> .5) -> this exact tap; traced miss (-1) -> broad field;
                // masked/untraced (0) -> centre hold. The denominator stays fixed
                // in all three cases, so this remains energy-preserving.
                const hit = step(0.5, tap.a);
                const miss = step(tap.a, -0.5);
                const absent = mix(exactCenter, broadDirectional, miss);
                sum.addAssign(mix(absent, vec3(tap.rgb), hit));
              }
            }
            exactRgb.assign(sum.mul(1 / 13));
          });
        }
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
          ? exactRgb
          : exactRgb.mul(irradiance.div(Math.PI).add(vec3(0.06)));
        // CLAMPED since the miss marker exists (2026-08-21): the resolve now
        // writes a = -1 on a TRACED miss (vs 0 on a masked skip), and an
        // unclamped negative alpha here would EXTRAPOLATE the mix instead of
        // ignoring it. `nestedKill` — see the NESTED-RENDER ARBITRATION
        // note above: this texture is main-view data.
        // ×exactFidelity — see its assignment above. At roughness 0 both this
        // confidence and the prefilter coverage are exactly 1, so a true
        // mirror is unchanged pixel-for-pixel.
        const exactWeight = exactHit.a.clamp(0, 1)
          .mul(smoothstep(0.45, 0.15, roughness)).mul(nestedKill).mul(exactFidelity);
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
        // metal, but sharp-and-stable beats banded. ×nestedKill: the trace
        // textures are main-view data (NESTED-RENDER ARBITRATION above).
        // ×exactFidelity, and it has to be BOTH this and the exact blend or
        // neither: this trace composites OVER that one (`light._mirrorOut`, at
        // the end of the specular chain), so damping only the blend would leave
        // the sharper of the two images painting the pixel. This arm has no
        // prefilter of its own at all, so the ramp is if anything more owed
        // here — a rough surface cannot honestly show a single mirror ray.
        const mirrorGate = smoothstep(0.45, 0.15, roughness)
          .mul(nestedKill).mul(exactFidelity).toVar();
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
            mirrorT = light.bvhReflectTexture.sample(giUV).r;
          } else if (light.bvhReflectTexture && light.mirrorTraceFn) {
            // PURE DATAFLOW, deliberately: the first version of this branch
            // hoisted the sample through `.toVar()` and gated the SDF trace
            // behind `If(flag)` — and rendered BLACK (bisected 2026-08-01:
            // v1-style direct-sample consumption + the SAME pass passes, so
            // the fault was in this branch's toVar/If structure, root cause
            // in three's codegen not chased). Direct sub-node reads + selects
            // are the v1 idiom that verifiably works. The unconditional SDF
            // trace costs what it cost before BVH existed.
            const tBvh = light.bvhReflectTexture.sample(giUV).r;
            const dynFlag = light.bvhReflectTexture.sample(giUV).g;
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
              bvhCol = light.bvhReflectColorTexture.sample(giUV);
              usedBvh = dynFlag.lessThanEqual(0.5).or(tBvh.greaterThanEqual(0).and(tSdf.lessThan(0).or(tBvh.lessThanEqual(tSdf))));
              // Exact hit normal (GI Phase 3 v3 — striping fix): octahedral-
              // decoded from bvhReflectTexture's OWN .zw (same texture as
              // t/dynFlag — see giScreen.js createGiBvhReflect's STRIPING
              // FIX comment). Direct texel read; decodeOctNormal is itself
              // a closed-form select() chain, no toVar/If anywhere in it.
              nHit = decodeOctNormal(light.bvhReflectTexture.sample(giUV).zw);
            }
          } else if (light.bvhReflectTexture) {
            mirrorT = light.bvhReflectTexture.sample(giUV).r;
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
                    // three's falloff + cone, shared with every other GI
                    // consumer (see `punctualAttenuation`'s header).
                    const { dirTo, atten } = punctualTermsAt(slot, hitPoint);
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
      if (rolledGlow && emitterData.length > 1) {
        // One loop body over the slot table (emitterGlowRolled): the
        // per-slot silhouette tests compile once. `__giRolledGlow = false`
        // keeps the unrolled form below for an A/B.
        glow = emitterGlowRolled(emitterData, positionWorld, reflected, roughness);
      } else for (const { slot, shadow, dist, dirToEmitter, active } of emitterData) {
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
      // ── THE SKY IS PART OF THE MIRROR (§12.71b v3, 2026-08-21) ──────────
      // A reflection ray that traced the WHOLE static scene and left it has
      // proven the environment is visible along R — the one case where
      // sampling the HDRI is occlusion-correct rather than the §12.64 leak
      // (which was per-material IBL running UNOCCLUDED everywhere). The
      // resolve marks that case with a NEGATIVE alpha in the bvh color
      // texture (-1 traced miss; 0 masked skip keeps the field fallback), so
      // this reads as pure dataflow at composite level — no dependence on
      // the mirror block's internal scope. Mirror-bucket materials only
      // (same 0.45→0.15 gate as the exact blend); a real hit or an SDF-union
      // hit composites AFTER this and wins. `step` zeroes the whole term
      // when the scene has no environment — black would otherwise DARKEN
      // the miss against today's field fallback.
      if (light.giEnvMiss && light.bvhReflectColorTexture) {
        const missA = light.bvhReflectColorTexture.sample(giUV).a;
        // ×exactFidelity, the third and worst-offending sharp-image consumer.
        // This term has no prefilter of ANY kind — one equirect tap of the HDRI
        // along the mirror direction — and an outdoor environment map's
        // brightest feature is a sun disc thousands of times the sky around it.
        // At full weight on a roughness-0.3 floor that is a single blown pixel
        // where a wide dim smear belongs, and on a scene like Sponza (open
        // roof, sunset HDRI) it lands on every glossy patch the sky can reach.
        const envW = missA.negate().clamp(0, 1)
          .mul(smoothstep(0.45, 0.15, roughness))
          .mul(exactFidelity)
          .mul(step(1e-4, float(light.giEnvMiss.intensity)));
        // Match three's own environment orientation: the lookup vector is
        // rotated by the scene's environmentRotation (Y), then equirectUV
        // (three's node, so the mapping convention cannot drift).
        const rot = float(light.giEnvMiss.rotY);
        const cr = cos(rot);
        const sr = sin(rot);
        const rd = vec3(
          reflected.x.mul(cr).add(reflected.z.mul(sr)),
          reflected.y,
          reflected.z.mul(cr).sub(reflected.x.mul(sr)),
        );
        let envRaw = vec3(light.giEnvMiss.node.sample(equirectUV(rd)).rgb);
        // §11.53b — the sun ceiling the sky tables book, applied to this tap
        // (see GISystem's sky poll). Scales the whole colour so the chroma
        // stays the map's; 1e30 (no sun / extraction off) is a no-op.
        if (light.giEnvMiss.ceiling) {
          const lum = envRaw.dot(vec3(0.2126, 0.7152, 0.0722));
          envRaw = envRaw.mul(float(1).min(float(light.giEnvMiss.ceiling).div(lum.max(1e-6))));
        }
        const envRad = envRaw.mul(float(light.giEnvMiss.intensity));
        spec = mix(spec, envRad.add(glow).mul(light.intensityUniform), envW);
      }
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

// ── ROLLED DIRECT-LIGHT LOOPS (2026-09-02, the reflection kernels' compile) ──
//
// `analyticDirectAt` / `emitterDirectAt` iterate their slot tables in JS, so
// every slot's shadow trace is INLINED at graph-build time: the exact-
// reflection hit shade and the reflection-probe capture each carried FOUR
// static-BVH8 descents, FOUR dynamic-BVH descents and FOUR emitter record
// marches in one 97 kB `main` (the kernel census in plan §9.5:
// `giStaticPlacementBvh8 ×8, giDynTrace ×8, giEmitterFactor ×8`), and the
// driver took 17–25 s to compile each of them on the user's Level (110 s on
// Bistro) — the two pipelines the boot's "first field" milestone was waiting
// on while the diffuse field had been on screen for 22 s. srcShade.js measured
// the same shape at ~1.2 s of compile PER INLINED DESCENT (§13.14.5) and rolled
// its loop; these are the same roll for the two hit-shading consumers. The
// slot's FIELDS are picked by index inside a GPU `Loop` (a `select` chain over
// the table — the slots are uniforms, and a select over four uniforms is
// nothing next to a descent), the per-slot maths runs once on the picked
// slot, and the trace is called ONCE per iteration: one descent in the
// program no matter how many slots the table has. Math-identical to the
// unrolled form (same terms, same gates, summed in slot order). The only
// change is cost: the unrolled form traced a slot whose term was zero; the
// rolled form skips that trace. `__giRolledDirect = false` (build-time)
// rebuilds the unrolled kernels for an A/B.
function pickSlotField(slots, field, i, kind) {
  const wrap = kind === "vec3" ? (v) => vec3(v) : (v) => float(v);
  const v = wrap(slots[0][field]).toVar();
  for (let k = 1; k < slots.length; k++) {
    // `.uniformFlow()`: three's ConditionalNode emits a `select()` ternary
    // only under that context — otherwise every pick is an if/else BLOCK
    // (~30 lines of WGSL per field per table, measured 2026-09-02 on the
    // rolled glow: eleven picks outweighed the four bodies they replaced).
    // Both operands are plain reads, so the ternary is the same math.
    v.assign(select(i.equal(int(k)), wrap(slots[k][field]), v).uniformFlow());
  }
  return v;
}

export function analyticDirectAtRolled(lightSlots, P, N, shadowFn, oneSided = false) {
  const total = vec3(0).toVar();
  const hasRange = lightSlots[0]?.range != null;
  const hasDecay = lightSlots[0]?.decay != null;
  const hasSpot = lightSlots[0]?.coneCos != null;
  Loop({ start: int(0), end: int(lightSlots.length), type: "int", condition: "<" }, ({ i }) => {
    // The slot, rebuilt from picked fields — `punctualTermsAt` reads every one
    // of them through `float()`/`vec3()`, so a table of picked vars stands in
    // for the uniform slot and the two forms cannot drift apart. Absent fields
    // stay absent (the helper gates on them), which is what keeps a fixture's
    // hand-built slot and a spot-less scene emitting the same graph as before.
    const picked = {
      kind: pickSlotField(lightSlots, "kind", i, "float"),
      vector: pickSlotField(lightSlots, "vector", i, "vec3"),
    };
    const active = pickSlotField(lightSlots, "active", i, "float");
    const color = pickSlotField(lightSlots, "color", i, "vec3");
    if (hasRange) picked.range = pickSlotField(lightSlots, "range", i, "float");
    if (hasDecay) picked.decay = pickSlotField(lightSlots, "decay", i, "float");
    if (hasSpot) {
      picked.axis = pickSlotField(lightSlots, "axis", i, "vec3");
      picked.coneCos = pickSlotField(lightSlots, "coneCos", i, "float");
      picked.penumbraCos = pickSlotField(lightSlots, "penumbraCos", i, "float");
    }
    If(active.greaterThan(0.5), () => {
      const { isDir, dirTo, dist: pointDist, atten } = punctualTermsAt(picked, P);
      const cosH = (oneSided ? dirTo.dot(N).max(0) : dirTo.dot(N).abs()).toVar();
      const lit = vec3(color).mul(atten).mul(cosH).toVar();
      If(lit.x.max(lit.y).max(lit.z).greaterThan(0), () => {
        total.addAssign(lit.mul(float(shadowFn(dirTo, isDir, pointDist, cosH, i)).clamp(0, 1)));
      });
    });
  });
  return total;
}

// Every field the emitter helpers read off a slot (emitterSlotFactor,
// emitterSurfaceT, emitterExclusion, emitterAngularRadius, emitterSlotShadow).
const EMITTER_SLOT_VEC3_FIELDS = ["center", "color", "half", "bx", "by", "bz", "exHalf"];
const EMITTER_SLOT_FLOAT_FIELDS = ["radius", "kind", "reff"];

export function emitterDirectAtRolled(params, P, N, samplePoint) {
  const slots = params.emitterSlots;
  const total = vec3(0).toVar();
  Loop({ start: int(0), end: int(slots.length), type: "int", condition: "<" }, ({ i }) => {
    const slot = {};
    for (const f of EMITTER_SLOT_VEC3_FIELDS) {
      if (slots[0][f] != null) slot[f] = pickSlotField(slots, f, i, "vec3");
    }
    for (const f of EMITTER_SLOT_FLOAT_FIELDS) {
      if (slots[0][f] != null) slot[f] = pickSlotField(slots, f, i, "float");
    }
    const center = vec3(slot.center);
    const toEmitter = center.sub(P).toVar();
    const dist = toEmitter.length().max(1e-3).toVar();
    const dirToEmitter = toEmitter.div(dist).toVar();
    const cosTheta = dirToEmitter.dot(N).toVar();
    const sinR = float(slot.radius).div(dist).clamp(0, 1).toVar();
    const emitterDirect = vec3(slot.color)
      .mul(emitterSlotFactor(slot, P, N, cosTheta, sinR))
      .toVar();
    const emitterLum = emitterDirect.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
    const cutD = emitterCutoff(params);
    const fadeT = emitterLum.sub(cutD).div(cutD * 2).clamp(0, 1).toVar();
    emitterDirect.mulAssign(
      fadeT.mul(fadeT).mul(fadeT).mul(fadeT.mul(fadeT.mul(6).sub(15)).add(10)),
    );
    const active = step(0.001, slot.radius);
    If(active.greaterThan(0.5).and(emitterLum.greaterThan(cutD)), () => {
      const shadow = float(emitterSlotShadow(params, slot, P, N, samplePoint)).toVar();
      total.addAssign(emitterDirect.mul(shadow));
    });
  });
  return { irradiance: total, shadows: [], perSlot: [] };
}

// ── ROLLED EMITTER GLOW (2026-09-02, the material fragment's compile) ───────
//
// The material path's emitter SPECULAR glow (GICascadeLightNode.setup above)
// iterated `emitterData` in JS, so every material that reflects carried FOUR
// copies of the per-slot body — cone test, the box/shape silhouette `If`
// chain with its `giBoxGlowMiss` / `giShapeGlowMiss` calls, the energy/
// shadow/active products — in one `main`: 17.2 kB of the 91 kB GI-injected
// fragment program (the size attribution of 2026-09-02). Same roll as
// emitterDirectAtRolled: the slot's uniforms are picked by index inside a
// GPU `Loop` (a `select` chain over the table), the per-slot SHADOW — a
// packed-texture channel on the deferred arm, a traced main-scope var on the
// legacy in-material arm — is picked the same way, and the body runs once.
// Math-identical to the unrolled form: same terms, same gates, summed in
// slot order 0..N-1. `__giRolledGlow = false` (build-time) keeps the
// unrolled form.
//
// `emitterData`: [{ slot, shadow }] — the slot uniform object and a float
// node readable at the caller's scope. `P`/`R`: receiver position and the
// reflection direction. `roughness`: the roughness the BSDF shades with.
//
// The fields the glow reads (emitterAngularRadius, the cone test, the box/
// shape silhouette tests, the active gate) — the direct lists minus `exHalf`,
// which only emitterExclusion consumes.
const GLOW_SLOT_VEC3_FIELDS = ["center", "color", "half", "bx", "by", "bz"];
const GLOW_SLOT_FLOAT_FIELDS = ["radius", "kind", "reff"];

export function emitterGlowRolled(emitterData, P, R, roughness) {
  const slots = emitterData.map((d) => d.slot);
  const glow = vec3(0).toVar();
  // Slot-independent inputs, hoisted so the loop body references main-scope
  // vars (the first use of a lazy node inside a loop would declare its temp
  // there — out of scope for every later consumer).
  const Pv = vec3(P).toVar();
  const Rv = vec3(R).toVar();
  const rough = float(roughness).toVar();
  // GGX-ish lobe widening: alpha = roughness², small floor for AA.
  const spread = rough.mul(rough).add(0.015).toVar();
  const hasKind = slots[0]?.kind != null;
  Loop({ start: int(0), end: int(slots.length), type: "int", condition: "<" }, ({ i }) => {
    const slot = {};
    for (const f of GLOW_SLOT_VEC3_FIELDS) {
      if (slots[0][f] != null) slot[f] = pickSlotField(slots, f, i, "vec3");
    }
    for (const f of GLOW_SLOT_FLOAT_FIELDS) {
      if (slots[0][f] != null) slot[f] = pickSlotField(slots, f, i, "float");
    }
    const shadow = pickSlotField(emitterData, "shadow", i, "float");
    const toEmitter = vec3(slot.center).sub(Pv).toVar();
    const dist = toEmitter.length().max(1e-3).toVar();
    const dirToEmitter = toEmitter.div(dist).toVar();
    const active = step(0.001, slot.radius);
    const cosAng = dirToEmitter.dot(Rv);
    // Angular size from the slot's effective radius (exact for spheres,
    // mean-projected-area for boxes) — drives softness and energy.
    const sinR = float(emitterAngularRadius(slot)).div(dist).clamp(0, 1).toVar();
    const effSin = sinR.add(spread).min(1).toVar();
    const cosEff = effSin.mul(effSin).oneMinus().max(0).sqrt().toVar();
    // Sphere slots: cone test around the direction to centre. Box slots:
    // angular distance from the reflected ray to the box's actual
    // silhouette. Shaped slots: the same silhouette contract via their SDF.
    const inCone = float(smoothstep(cosEff, mix(cosEff, 1, 0.35), cosAng)).toVar();
    if (hasKind) {
      const kindG = float(slot.kind);
      If(kindG.greaterThan(0.5).and(kindG.lessThan(1.5)), () => {
        const miss = boxGlowMiss(
          Pv, Rv,
          vec3(slot.center), vec3(slot.half), vec3(slot.bx), vec3(slot.by), vec3(slot.bz),
        );
        inCone.assign(smoothstep(0.0, spread, miss).oneMinus());
      }).ElseIf(kindG.greaterThan(1.5), () => {
        const miss = shapeGlowMiss(
          Pv, Rv, kindG,
          vec3(slot.center), vec3(slot.half), vec3(slot.bx), vec3(slot.by), vec3(slot.bz),
        );
        inCone.assign(smoothstep(0.0, spread, miss).oneMinus());
      });
    }
    const energy = sinR.mul(sinR).div(effSin.mul(effSin).max(1e-6));
    glow.addAssign(vec3(slot.color).mul(inCone).mul(energy).mul(shadow).mul(active));
  });
  return glow;
}
