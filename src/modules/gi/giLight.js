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

/**
 * Geometric irradiance factor of one emitter slot (E = slot.color · factor):
 * the sphere-area model for sphere slots, the exact box form factor for box
 * slots. ONE function used by the receiver direct term, the voxel feedback
 * inject, and reflection-hit lighting — divergence between those three shows
 * up as light that changes when a lamp is viewed via a different path.
 */
export function emitterSlotFactor(slot, P, N, cosTheta, sinR) {
  const sphereF = float(Math.PI).mul(sinR).mul(sinR).mul(sphereLightFactor(cosTheta, sinR));
  if (!slot.kind) return sphereF;
  const factor = sphereF.toVar();
  If(float(slot.kind).greaterThan(0.5), () => {
    factor.assign(
      boxLightFactor(P, N, vec3(slot.center), vec3(slot.half), vec3(slot.bx), vec3(slot.by), vec3(slot.bz)),
    );
  });
  return factor;
}

/**
 * The shadow ray's reach toward a slot: to the sphere surface, or to the
 * box's actual face (slab entry) for box slots.
 */
export function emitterSurfaceT(slot, P, dirToEmitter, dist) {
  const sphereT = dist.sub(slot.radius);
  if (!slot.kind) return sphereT;
  const t = sphereT.toVar();
  If(float(slot.kind).greaterThan(0.5), () => {
    t.assign(
      boxRayEnter(P, dirToEmitter, vec3(slot.center), vec3(slot.half), vec3(slot.bx), vec3(slot.by), vec3(slot.bz)),
    );
  });
  return t;
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
export function emitterDirectAt(params, P, N, samplePoint) {
  const total = vec3(0).toVar();
  const shadows = [];
  const perSlot = [];
  for (const slot of params.emitterSlots) {
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

    const shadow = float(1).toVar();
    // Trace gates beyond the basics: below cosθ 0.05 the grazing fade
    // discards the traced result entirely, and a contribution too dim to see
    // doesn't earn a march either — both skip the trace outright.
    // CRITICAL: light too dim to TRACE must also be too dim to SHOW — the old
    // gate skipped the trace but KEPT the contribution, so dim emitter light
    // crossed walls unshadowed and read clearly in dark adjacent rooms.
    const emitterLum = emitterDirect.dot(vec3(0.2126, 0.7152, 0.0722)).toVar();
    emitterDirect.mulAssign(smoothstep(0.0005, 0.0015, emitterLum));
    If(
      slot.radius.greaterThan(0.001)
        .and(cosTheta.greaterThan(0.05))
        .and(dist.lessThan(params.shadowRange))
        .and(emitterLum.greaterThan(0.0015)),
      () => {
        // SDF sphere-traced penumbra: ONE ray, smooth by construction.
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
          // IS the sphere). Box slots: the OBB dilated by the margin — the
          // bounding sphere of a big panel swallowed nearby ceilings/walls,
          // which then stopped occluding (light poured through into the
          // next room as a circle) and its boundary ringed the pool.
          const kindF = slot.kind ? float(slot.kind) : null;
          const exRadius = kindF
            ? mix(slot.radius.mul(1.5).add(params.shadowMargin), float(params.shadowMargin), kindF)
            : slot.radius.mul(1.5).add(params.shadowMargin);
          const exBox = kindF
            ? { half: mix(vec3(-1), vec3(slot.half), kindF), bx: slot.bx, by: slot.by, bz: slot.bz }
            : null;
          const traced = params.shadowTraceFn(
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
    const active = step(0.001, slot.radius);
    total.addAssign(emitterDirect.mul(shadow).mul(active));
    shadows.push(shadow);
    perSlot.push({ slot, shadow, dist, dirToEmitter, active });
  }
  return { irradiance: total, shadows, perSlot };
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
    // bx/by/bz, reff} uniforms (kind 0 = sphere, 1 = oriented box — see
    // emitterSlotFactor); shadowTraceFn = voxel DDA (origin, dir, maxT)
    // => { rad, t }.
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
    const irradiance = deferred
      ? vec3(light.giIrradianceNode.sample(screenUV)).toVar()
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
        const packed = light.giEmitterShadowNode.sample(screenUV).toVar();
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
                      const kindF = slot.kind ? float(slot.kind) : null;
                      const exRadius = kindF
                        ? mix(slot.radius.mul(1.5).add(light.shadowMargin), float(light.shadowMargin), kindF)
                        : slot.radius.mul(1.5).add(light.shadowMargin);
                      const exBox = kindF
                        ? { half: mix(vec3(-1), vec3(slot.half), kindF), bx: slot.bx, by: slot.by, bz: slot.bz }
                        : null;
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
        // emissives look like a sphere" report).
        const inCone = float(smoothstep(cosEff, mix(cosEff, 1, 0.35), cosAng)).toVar();
        if (slot.kind) {
          If(float(slot.kind).greaterThan(0.5), () => {
            const miss = boxGlowMiss(
              positionWorld, reflected,
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
