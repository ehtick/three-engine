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
  cameraPosition,
  float,
  materialRoughness,
  mix,
  normalWorld,
  positionWorld,
  reflect,
  screenUV,
  smoothstep,
  step,
  cross,
  uniform,
  vec3,
} from "three/tsl";

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
 * Promoted emissive emitters as analytic sphere area lights, with SDF
 * sphere-traced penumbrae: E = color · πsin²R · horizonFactor · shadow.
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
    const solidAngle = float(Math.PI).mul(sinR).mul(sinR);
    // Horizon-aware factor (see sphereLightFactor): a floor-hugging lamp
    // still lights the floor around it smoothly.
    const emitterDirect = vec3(slot.color)
      .mul(solidAngle)
      .mul(sphereLightFactor(cosTheta, sinR))
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
        // k = distance / emitter radius encodes the light's angular size:
        // bigger/closer emitter → softer. Floor 1.2 so a large area lamp
        // close to the receiver keeps a wide, soft penumbra.
        const k = dist.div(slot.radius.max(0.05)).clamp(1.2, 48);
        const maxT = dist.sub(slot.radius).sub(params.shadowMargin).max(0);
        If(maxT.greaterThan(params.shadowMargin), () => {
          // Self-exclusion covers ONLY the lamp's own body + a couple of
          // field cells — a fixed larger radius would exempt any wall near
          // the lamp from occluding and pour light through it.
          const traced = params.shadowTraceFn(
            samplePoint, dirToEmitter, maxT, k, cosTheta,
            center, slot.radius.mul(1.5).add(params.shadowMargin),
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
    // Set by GISystem after construction: (P, N) => vec3 irradiance.
    // Still used by the legacy in-material path (no gbuffer) and by the
    // resolve pass itself.
    this.gatherFn = null;
    // Optional: (P, R) => vec3 radiance along R — feeds indirect specular.
    // `radianceFn` = mid-angular cascade (soft gloss), `radianceSharpFn` =
    // finest-angular cascade (low-roughness reflections).
    this.radianceFn = null;
    this.radianceSharpFn = null;
    // Optional emissive-area-shadow inputs (see GISystem #updateEmitters):
    // emitterSlots = MAX_EMITTERS × {center, radius, color} uniforms;
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
      : vec3(light.gatherFn(samplePoint, N)).mul(light.intensityUniform);
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

    // Glossy GI reflections: cascade radiance along the reflection vector →
    // context.radiance, which PhysicalLightingModel consumes as indirect
    // specular with full Fresnel/roughness weighting. Coexists with SSR
    // (SSR wins where it hits; this fills everything else).
    if (light.radianceFn && builder.context.radiance) {
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
      const softLookup = vec3(light.radianceFn(samplePoint, reflected));
      // Low roughness → the finest-angular cascade (sharpest reflection the
      // field can express); mid roughness → the mid cascade; high roughness
      // → cosine-average radiance (no directional structure at all).
      let directional = softLookup;
      if (light.radianceSharpFn) {
        const sharpLookup = vec3(light.radianceSharpFn(samplePoint, reflected));
        directional = mix(sharpLookup, softLookup, smoothstep(0.02, 0.3, roughness));
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
      if (light.mirrorTraceFn && light.mirrorSampleFn && canMirror) {
        // Wider roughness range than the old 0.08-0.3: mid-roughness metals
        // otherwise fall back to the cascade probe lookup, whose sparse
        // probe lattice banded visibly (vertical stripes on metallic
        // boxes). The traced result reads slightly too sharp for rough
        // metal, but sharp-and-stable beats banded.
        const mirrorGate = smoothstep(0.45, 0.15, roughness).toVar();
        const mirrorOut = vec3(0).toVar();
        const mirrorWeight = float(0).toVar();
        If(mirrorGate.greaterThan(0.001), () => {
          const mirror = light.mirrorTraceFn(samplePoint, reflected, light.mirrorRange ?? 24);
          const hitPoint = samplePoint.add(reflected.mul(mirror.t.max(0))).toVar();
          const sampled = light.mirrorSampleFn(hitPoint);
          const hitRad = vec3(sampled.rad).toVar();
          if (light.hitSurfaceFn && light.mirrorShadowFn && light.hitLighting) {
            const hitSurface = light.hitSurfaceFn(hitPoint);
            If(hitSurface.valid.greaterThan(0.5), () => {
              const hitN = hitSurface.normal;
              const hitOrigin = hitPoint.add(hitN.mul(light.normalOffset)).toVar();
              const direct = vec3(0).toVar();
              if (light.emitterSlots?.length) {
                for (const slot of light.emitterSlots) {
                  If(slot.radius.greaterThan(0.001), () => {
                    const rel = vec3(slot.center).sub(hitPoint).toVar();
                    const dist = rel.length().max(1e-3).toVar();
                    const dirTo = rel.div(dist).toVar();
                    // |cos| both sides — thin geometry has arbitrary facing
                    // (same convention as the feedback's voxel direct).
                    const cosH = dirTo.dot(hitN).abs().toVar();
                    const sinRH = float(slot.radius).div(dist).clamp(0, 1).toVar();
                    const solidAngle = float(Math.PI).mul(sinRH).mul(sinRH);
                    const shadowH = float(1).toVar();
                    const k = dist.div(slot.radius.max(0.05)).clamp(1.2, 48);
                    const maxT = dist.sub(slot.radius).sub(light.shadowMargin).max(0);
                    If(maxT.greaterThan(light.shadowMargin), () => {
                      shadowH.assign(
                        light.mirrorShadowFn(
                          hitOrigin, dirTo, maxT, k, cosH,
                          vec3(slot.center), slot.radius.mul(1.5).add(light.shadowMargin),
                        ),
                      );
                    });
                    direct.addAssign(
                      vec3(slot.color).mul(solidAngle).mul(sphereLightFactor(cosH, sinRH)).mul(shadowH),
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
              hitRad.assign(sampled.rad.add(hitSurface.albedo.mul(direct).div(Math.PI)));
            });
          }
          mirrorOut.assign(hitRad);
          mirrorWeight.assign(mirrorGate.mul(step(0, mirror.t)).mul(sampled.coverage.clamp(0, 1)));
        });
        light._mirrorOut = mirrorOut;
        light._mirrorWeight = mirrorWeight;
      }

      // Emitter SPECULAR: sphere light vs the roughness-widened reflection
      // cone, energy-conserving (Karis representative-sphere ratio),
      // occluded by the slot's diffuse-direction penumbra. Added to the
      // FIELD path (inside the roughness collapse below — on rough
      // surfaces the widened-cone glow otherwise washes out diffuse
      // shadows entirely) AND to the mirror path (mirror pixels are
      // low-roughness, where the glow is sharp and correct).
      let glow = vec3(0);
      for (const { slot, shadow, dist, dirToEmitter, active } of emitterData) {
        const cosAng = dirToEmitter.dot(reflected);
        const sinR = float(slot.radius).div(dist).clamp(0, 1).toVar();
        // GGX-ish lobe widening: alpha = roughness², small floor for AA.
        const effSin = sinR.add(roughness.mul(roughness)).add(0.015).min(1).toVar();
        const cosEff = effSin.mul(effSin).oneMinus().max(0).sqrt().toVar();
        const inCone = smoothstep(cosEff, mix(cosEff, 1, 0.35), cosAng);
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
