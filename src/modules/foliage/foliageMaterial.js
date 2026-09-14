import * as THREE from "three/webgpu";
import {
  Fn, attribute, float, fract, length, max as tslMax, normalMap, normalViewGeometry,
  screenCoordinate, select, smoothstep, struct, texture, uniform, uv, vec2, vec3, vec4,
} from "three/tsl";
import { getFoliageSurfaceTextures } from "./foliageSurfaceTexture.js";
import { installFoliageLeafLighting } from "./foliageLighting.js";
import { foliageAnimatedPosition, foliageInstanceMatrix } from "./foliageWind.js";
import { SCENE_WIND_DEFAULTS, windVector } from "../../engine/vfx/clothWind.js";
export { setupFoliageImpostorMaterial } from "./foliageWind.js";

// Uniforms, never storage buffers: GI keeps its portable eight-buffer budget.
export const FOLIAGE_INTERACTION_LIMIT = 8;

export function createFoliageUniforms() {
  return {
    time: uniform(0), strength: uniform(0), speed: uniform(1), direction: uniform(new THREE.Vector3(1, 0, 0)),
    /** ⭐ HOW FAR the wind may bend a thing, 1 at the default 2 m/s scene wind.
     *  Scales every saturating cap in `foliageWind.js` — see `softLimit`. */
    reach: uniform(1),
    interaction: uniform(0), radius: uniform(1),
    gustStrength: uniform(.6), gustScale: uniform(12), turbulence: uniform(.25),
    colliders: Array.from({ length: FOLIAGE_INTERACTION_LIMIT }, () => ({
      center: uniform(new THREE.Vector4(0, 0, 0, 0)),
      x: uniform(new THREE.Vector4(1, 0, 0, 0)),
      y: uniform(new THREE.Vector4(0, 1, 0, 0)),
      z: uniform(new THREE.Vector4(0, 0, 1, 0)),
    })),
  };
}

/** Which stored channel carries "is this vertex leaf or bark": the shared
 * tree-motion interleaved stream's spare `.w` component when present (trees),
 * a dedicated attribute otherwise (nothing else currently writes it, but the
 * lookup stays generic rather than assuming a species). Factored out so
 * `createFoliageMaterial` can fold this SAME value into its own packed
 * varying instead of letting `createFoliageSurfaceMaterial` mint its own
 * separate one — see `foliagePack` below. */
function foliagePartValue(builder) {
  return builder.geometry.hasAttribute("treeLeafAxis") ? attribute("treeLeafAxis", "vec4").w : attribute("foliagePart", "float");
}

/**
 * The same unanimated surface is used by the neutral impostor atlas bake.
 *
 * `partNode` lets a caller that ALREADY has this value crossing the
 * vertex→fragment boundary some other way (`createFoliageMaterial`'s packed
 * `foliagePack` varying) hand it in directly, instead of this function
 * promoting `foliagePartValue` to its OWN separate varying — a second,
 * redundant fragment-stage read of the identical data (three's
 * `getVaryingFromNode` dedupes by NODE IDENTITY, never by name, so two
 * independently-built promotions of the same attribute cost two varying
 * slots). The bake-source use (`acquireFoliageSurfaceMaterial`, no fade/pack
 * to share) omits it and keeps the original single promotion.
 */
export function createFoliageSurfaceMaterial(props = {}, partNode = null) {
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: .88, metalness: 0, side: THREE.DoubleSide });
  const surfaces = getFoliageSurfaceTextures(props.species);
  if (surfaces) {
    const part = partNode ?? Fn(builder => foliagePartValue(builder))();
    const leaf = part.greaterThan(.5);
    // ONE uv() read, reused by both samples — two separate `uv()` calls each
    // mint their own `AttributeNode`, and three's varying dedup (identity, not
    // name) would promote each to its own fragment-stage varying.
    const uvCoord = uv();
    const leafSample = texture(surfaces.leaves, uvCoord);
    const barkSample = texture(surfaces.bark, uvCoord);
    const sample = leaf.select(leafSample, barkSample);
    material.colorNode = vec3(sample.r);
    material.opacityNode = leaf.select(leafSample.a, 1);
    material.alphaTest = .5;
    // Three's depth/shadow override reads maskShadowNode but does not forward
    // opacityNode. This is the identical silhouette, including the same mips.
    material.maskShadowNode = material.opacityNode.greaterThan(.5);
    // ⭐⭐ LEAVES SHADE AS A CANOPY, NOT AS CARDS (09-14). A DoubleSide card's
    // `normalView` is negated on its back face, so with cards facing every way
    // half of any crown shaded as the side turned AWAY from the sun — the
    // salt-and-pepper lit/dark speckle, and impostor normal atlases that
    // averaged to noise. The geometry normal is already bent toward the crown
    // envelope (`foliageGeometry.js#leafSprayCard`); read it UNFLIPPED so both
    // faces of a card shade as the canopy surface they belong to. Leaves drop
    // the per-leaf bump (sub-texel noise past a few metres); bark keeps the
    // half-strength map — steeper sent the highlight sweeping on rotation.
    material.normalNode = leaf.select(normalViewGeometry, normalMap(vec3(sample.g, sample.b, 1), vec2(0.45)));
    // Leaf surfaces differ from dry bark and from each other. Keep both the
    // live material and neutral atlas source on this same modest variation;
    // albedo tint stays authored and no emissive fill hides the shading.
    // ⭐ 09-13 owner receipt: "leaves look like they have metalness on them,
    // characteristic metallic lighting when the camera rotates, plus a
    // bluish reflection from the sky" — the base roughness (.64/.72/.76) was
    // low enough, combined with a full-intensity sky envMap (see
    // `material.envMapIntensity` below), to put a tight, glossy specular
    // lobe and a mirrored sky tint on a surface that should look matte.
    // (Roughness only shaped the sheen; the leaf lighting now removes it.)
    // Raised the floor to .88-.92; the same `.12` atlas modulation on top
    // still gives per-leaf roughness variation, it just never dips low.
    const leafRoughness = props.species === "pine" ? .88 : props.species === "birch" ? .92 : .90;
    material.roughnessNode = leaf.select(leafSample.r.oneMinus().mul(.12).add(leafRoughness), .96);
    // The sky must not mirror on leaves — not via `envMapIntensity` (three
    // ignores it without a material envMap); `installFoliageLeafLighting`
    // zeroes leaf F0/F90 instead, which also removes the grazing sky sheen.
    // Wrap, translucency, matte specular and the hemisphere fill — leaves
    // only, shared with the far impostor (see `foliageLighting.js`). The
    // neutral atlas bake has no direct light, so it still captures albedo.
    installFoliageLeafLighting(material, leaf.select(1, 0));
  }
  material.name = "Foliage · surface";
  return material;
}

/**
 * ── PER-INSTANCE DITHERED LOD CROSSFADE (P1-B) ────────────────────────────
 *
 * `FoliageComponent` now hands the SAME chunk's instance data to two shared
 * render meshes at once inside a crossfade band (`foliageLod.js`'s superset
 * filter) — which of the two a given instance actually shows, this frame, is
 * decided HERE, per instance, in the vertex stage, from real distance. Tier
 * membership never decides visibility any more; this weight does.
 *
 * Thresholds (`lodNear/lodFar/maxDistance`) are per-COMPONENT props, but this
 * material may be SHARED by many components (`foliageMaterialKey` above only
 * keys on species + wind/interaction values). Baking a threshold as a shader
 * CONSTANT — the way `animateTree` already, pre-existingly, bakes `height` —
 * would leak one holder's distances into every other holder's draw. Instead
 * they ride as ordinary per-OBJECT state, the same way `instanceMatrix`
 * itself already does (`foliageInstanceMatrix` reads `builder.object`, not a
 * material uniform): `.onObjectUpdate` re-reads `object.userData.foliageLod*`
 * before every object's draw. `FoliageComponent.update()` writes those fields
 * once a frame on each of its three shared render meshes.
 */
function foliageLodBandNode(threshold) {
  // The exact CPU twin of `foliageLodBand` in `foliageLod.js` — keep both in
  // sync by construction: 25% of the threshold, floored at 6 m.
  return tslMax(threshold.mul(.25), 6);
}

function foliageCrossfadeNode(edge, band, distance) {
  return smoothstep(edge.sub(band.mul(.5)), edge.add(band.mul(.5)), distance);
}

function foliageLodObjectUniforms() {
  return {
    near: uniform(0).onObjectUpdate(({ object }) => object.userData.foliageLodNear ?? 0),
    far: uniform(0).onObjectUpdate(({ object }) => object.userData.foliageLodFar ?? 0),
    end: uniform(0).onObjectUpdate(({ object }) => object.userData.foliageLodEnd ?? 0),
    // ⭐ THE SHADOW-SIDE HANDOFF (`props.shadowFar`, resolved by
    // `foliageLod.js#foliageShadowFar` and written by `FoliageComponent.update()`
    // as `userData.foliageShadowLodFar`). Where the SHADOW pass fades mid-tier
    // geometry over to the impostor tier, independently of the colour pass's
    // `far` — a shadow past ~100 m is a blob and doesn't need its geometry.
    // Always written (defaulting to `far`), so the shadow pass replays the
    // colour decision exactly when the prop is unset.
    shadowFar: uniform(0).onObjectUpdate(({ object }) => object.userData.foliageShadowLodFar ?? 0),
    // 0..1: how much of the impostor bake's arrival has faded in (see
    // `foliageApplyImpostorRamp` in `foliageLod.js`). `FoliageComponent`
    // promotes a chunk to the impostor tier the instant the bake exists
    // rather than waiting on this (the live commit path assigns a whole
    // chunk to exactly one tier, so there is no SECOND tier left drawing the
    // ramped-out leftover) — the formulas already agree exactly at `lodFar`,
    // so that swap is a detail change, not a coverage pop, and this defaults
    // to "fully arrived" until a superset commit path drives it lower.
    ramp: uniform(1).onObjectUpdate(({ object }) => object.userData.foliageImpostorRamp ?? 1),
    // 1 while a clipmap shadow level has chosen this mesh's LOD for every plant
    // it covers (`clipmapShadowCache.js#foliageShadowTierRule`): every instance
    // the mesh holds casts at full weight, whatever its viewer-distance fade.
    // Only ever set around that one shadow draw, so the colour pass never sees it.
    shadowForce: uniform(0).onObjectUpdate(({ object }) => (object.userData.foliageShadowForce ? 1 : 0)),
    // Which shared mesh this draw is: the near mesh (0) or the mid mesh (1).
    // Both use this SAME material — `FoliageComponent._buildRenderBatches`
    // tags each renderMesh once at creation.
    mid: uniform(0).onObjectUpdate(({ object }) => object.userData.foliageLodTier ?? 0),
    // ⭐⭐ THE VIEWER, NEVER THE PASS CAMERA (see `foliageFadeNode` below for
    // why TSL's `cameraPosition` broke shadows). `FoliageComponent.update()`
    // writes its own `this._viewerPosition` (from `engine.camera`, the actual
    // player/editor viewpoint) onto `mesh.userData.foliageViewerPosition` for
    // every one of ITS render meshes, once a frame; `.onObjectUpdate` re-reads
    // it before every object's draw, in every pass, so a shadow-map draw
    // (whose pass camera is the light's orthographic frustum) still fades by
    // distance from the viewer instead of from the light. Falls back to
    // `self.value` (its last-known-good value) rather than snapping to the
    // origin if a mesh is ever drawn before the component's first `update()`.
    viewerPosition: uniform(new THREE.Vector3()).onObjectUpdate(({ object }, self) => object.userData.foliageViewerPosition ?? self.value),
  };
}

const FoliageFade = struct({ position: "vec3", weight: "float", distance: "float" }, "FoliageFade");
const FoliageFadeWeight = struct({ pivot: "vec3", weight: "float", distance: "float" }, "FoliageFadeWeight");

/** The per-instance crossfade weight and scale-normalised viewer distance — uniforms and the
 * instance matrix ONLY, never the animated position. Both the vertex position collapse and the
 * packed varying recompute this independently (a few ALU ops) instead of sharing one
 * material-scope `.toVar()` struct: a shared variable that also carried the wind-animated
 * position was being generated in the FRAGMENT stage as a dead value, and every raw vertex
 * attribute the wind reads (branch/leaf axes, curve, blade, position, normal, instanceIndex)
 * got promoted to its own varying — 16 user-defined varyings, over WebGPU's limit (owner
 * receipt 09-13, `profile.wgsl`). */
function foliageFadeWeightNode(builder, lod) {
  const matrix = foliageInstanceMatrix(builder);
  const pivot = matrix.mul(vec4(0, 0, 0, 1)).xyz;
  const instanceScale = tslMax(length(matrix.mul(vec4(1, 0, 0, 0)).xyz), 1e-4);
  const distance = length(pivot.sub(lod.viewerPosition)).div(instanceScale);
  const bandNear = foliageLodBandNode(lod.near), bandFar = foliageLodBandNode(lod.far), bandEnd = foliageLodBandNode(lod.end);
  const fadeNear = foliageCrossfadeNode(lod.near, bandNear, distance);
  const fadeFar = foliageCrossfadeNode(lod.far, bandFar, distance);
  const fadeEnd = foliageCrossfadeNode(lod.end, bandEnd, distance);
  const nearWeight = float(1).sub(fadeNear);
  const midRaw = fadeNear.mul(float(1).sub(fadeFar));
  const impostorRaw = fadeFar.mul(float(1).sub(fadeEnd));
  const midWeight = midRaw.add(impostorRaw.mul(float(1).sub(lod.ramp)));
  const weight = select(lod.shadowForce.greaterThan(.5), float(1), select(lod.mid.greaterThan(.5), midWeight, nearWeight));
  return FoliageFadeWeight(pivot, weight, distance);
}

function foliageFadeNode(builder, lod, animated) {
  const fade = foliageFadeWeightNode(builder, lod);
  const collapsed = select(fade.get("weight").lessThanEqual(1e-3), fade.get("pivot"), animated);
  return FoliageFade(collapsed, fade.get("weight"), fade.get("distance"));
}

function foliageDitherNoiseNode() {
  return fract(float(52.9829189).mul(fract(screenCoordinate.x.mul(.06711056).add(screenCoordinate.y.mul(.00583715)))));
}

/**
 * ⭐⭐ THE COMPLEMENTARY DISCARD RULE (P1-B follow-up, 09-13) — the exact TSL
 * twin of `foliageLod.js#foliageTierKeeps`; see that function's doc for the
 * hole/double-draw bug this replaces. This material only ever draws tier 0
 * (near, `lod.mid` false) or tier 1 (mid, `lod.mid` true) — the impostor tier
 * lives in `impostorMaterial.js` and always plays the far role, so it needs
 * no distance-dependent branch. The near mesh always keeps the CLOSE rule
 * (`noise < weight`); the mid mesh keeps the FAR rule (`noise >= 1 - weight`)
 * while `distance` is below the near/far midpoint (partnering the near tier)
 * and the CLOSE rule beyond it (partnering the impostor tier).
 *
 * ⭐⭐ ONE VARYING, NOT TWO (09-13 fix) — this used to carry `distance` AND
 * `weight` to the fragment stage as two separate `.toVarying()` floats so the
 * rule choice (`midRule`/`select(lod.mid...)` above) could be resolved per
 * FRAGMENT. Every one of those inputs (`distance`, `lod.near/far/mid`) is
 * already known per-VERTEX (indeed per-INSTANCE — nothing here varies across
 * an instance's own vertices except `weight`, which the whole rule already
 * treats as instance-uniform), so the *rule itself* can be resolved in the
 * vertex stage and only its ONE numeric OUTCOME needs to reach the fragment
 * stage. `foliageDitherThreshold` computes that outcome in the vertex stage;
 * `foliageDitherSurvivesFromThreshold` decodes it in the fragment stage against
 * the per-pixel noise. The encoding exploits `weight` and `1-weight` both
 * living in [0, 1]: the CLOSE-rule case is passed through unchanged (>= 0, so
 * "close" is recoverable as "not shifted"), the FAR-rule case is shifted by
 * -2 into [-2, -1] — a range that can never overlap the close-rule's [0, 1],
 * so the sign alone tells the fragment which comparison to run, and there is
 * no zero/negative-zero ambiguity the way encoding the rule as a literal sign
 * flip on the threshold itself would have.
 */
function foliageDitherThreshold(lod, distance, weight) {
  const midpoint = lod.near.add(lod.far).mul(.5);
  const midRule = select(distance.lessThan(midpoint), float(1).sub(weight).sub(2), weight);
  return select(lod.mid.greaterThan(.5), midRule, weight);
}

/**
 * ⭐ THE SHADOW PASS'S OWN THRESHOLD — the same encoding as
 * `foliageDitherThreshold`, computed against `lod.shadowFar` instead of
 * `lod.far`, carried to the fragment stage in `pack.z` and consumed ONLY by
 * `maskShadowNode` (three's shadow-map material reads that node and never
 * `opacityNode` — see the fade block in `createFoliageMaterial`). The colour
 * pass keeps replaying `pack.x`, so the picture is untouched; the shadow
 * simply hands mid-tier geometry over to the impostor tier at the prop's
 * shorter distance.
 *
 * `weight` cannot be passed in: it was computed against `lod.far`. The near
 * fade is recomputed here — the file's standing pattern (a few ALU ops rather
 * than a shared `.toVar()` struct that drags wind-animated position into the
 * fragment stage) — and the mid weight re-folded against the SHADOW far fade.
 * The near tier's own weight has no `far` term, so with `shadowFar === far`
 * (the unset default) this produces bit-identical decisions to `pack.x`.
 */
function foliageShadowDitherThreshold(lod, distance) {
  const bandNear = foliageLodBandNode(lod.near);
  const fadeNear = foliageCrossfadeNode(lod.near, bandNear, distance);
  const bandShadow = foliageLodBandNode(lod.shadowFar);
  const fadeFarShadow = foliageCrossfadeNode(lod.shadowFar, bandShadow, distance);
  const nearWeight = float(1).sub(fadeNear);
  const midWeight = fadeNear.mul(float(1).sub(fadeFarShadow));
  const weight = select(lod.mid.greaterThan(.5), midWeight, nearWeight);
  const midpoint = lod.near.add(lod.shadowFar).mul(.5);
  const midRule = select(distance.lessThan(midpoint), float(1).sub(weight).sub(2), weight);
  // A forced level draw casts every instance: encoded close-rule weight 1.
  return select(lod.shadowForce.greaterThan(.5), float(1), select(lod.mid.greaterThan(.5), midRule, weight));
}

function foliageDitherSurvivesFromThreshold(encoded) {
  const noise = foliageDitherNoiseNode().toVar();
  const isCloseRule = encoded.greaterThanEqual(0);
  const threshold = select(isCloseRule, encoded, encoded.add(2));
  return select(isCloseRule, noise.lessThan(threshold), noise.greaterThanEqual(threshold));
}

export function createFoliageMaterial(uniforms, props = {}) {
  const animated = foliageAnimatedPosition(uniforms, props);
  const lod = foliageLodObjectUniforms();
  const hasSurfaceTextures = !!getFoliageSurfaceTextures(props.species);
  // ONE packed varying (colour dither threshold in .x, leaf/bark part id in .y,
  // SHADOW dither threshold in .z), computed in the
  // vertex stage from uniforms + the instance matrix only — see `foliageFadeWeightNode`.
  // It deliberately shares NO node with the position path below.
  const pack = Fn((builder) => {
    const fade = foliageFadeWeightNode(builder, lod);
    return vec4(
      foliageDitherThreshold(lod, fade.get("distance"), fade.get("weight")),
      hasSurfaceTextures ? foliagePartValue(builder) : float(0),
      foliageShadowDitherThreshold(lod, fade.get("distance")),
      0,
    );
  })().toVarying();
  const material = createFoliageSurfaceMaterial(props, hasSurfaceTextures ? pack.y : null);
  material.name = "Foliage · living surface";
  material.positionNode = Fn((builder) => foliageFadeNode(builder, lod, animated))().get("position");
  const coverage = material.opacityNode ?? float(1);
  // Fold the dither into the ALPHA VALUE (multiply toward 0) rather than an
  // imperative discard, and let the material's existing `alphaTest` do the
  // discarding — the same mechanism `createFoliageSurfaceMaterial` already
  // relies on. This is what lets the shadow pass carry the fade too: three's
  // shadow-map material reads `maskShadowNode`, never `opacityNode` (see the
  // comment above), so `maskShadowNode` is rebuilt from this SAME faded value
  // instead of the original leaf/bark-only coverage — a plant now fades out
  // of its own shadow in step with fading out of the colour pass, rather
  // than a shadow silhouette outliving the geometry that cast it.
  const survives = select(foliageDitherSurvivesFromThreshold(pack.x), float(1), float(0));
  const fadedCoverage = coverage.mul(survives);
  material.opacityNode = fadedCoverage;
  // The SHADOW pass replays `pack.z` — the threshold computed against
  // `lod.shadowFar` (see `foliageShadowDitherThreshold`) — so a plant fades out
  // of its own shadow and over to the impostor tier at the prop's handoff
  // distance while its colour-pass look stays governed by `pack.x`. With
  // `shadowFar` unset the two thresholds are equal and this is the colour
  // decision replayed, exactly as before this node existed.
  //
  // ⛔ BUT NEVER DITHERED (09-14, "they stop casting shadow when cross fading").
  // The screen-door split is exact only where both tiers cover the SAME pixels.
  // In the shadow map the near and mid meshes have different cards, so each
  // tier cast only its dithered half of its own silhouette and the shadow
  // thinned to holes across the whole band. Occluders union — two tiers
  // casting at once is invisible in a shadow — so every tier with any weight
  // casts fully. `pack.z` encodes the weight itself on the close rule (≥ 0) and
  // `1 − weight − 2` on the far rule, so it is recovered without a new varying.
  const shadowWeight = select(pack.z.greaterThanEqual(0), pack.z, pack.z.add(1).negate());
  material.maskShadowNode = coverage.greaterThan(.5).and(shadowWeight.greaterThan(1e-3));
  // Species without leaf/bark textures (grass, wildflowers) leave alphaTest
  // at 0 — nothing to cut out before now. The dither needs SOME alpha test
  // to actually discard through, so floor it here rather than inside
  // `createFoliageSurfaceMaterial` (whose `surface.alphaTest === living.alphaTest`
  // contract for textured species, and `surface.alphaTest === 0` contract for
  // grass/wildflowers, both belong to the atlas bake's own untouched material).
  material.alphaTest = Math.max(material.alphaTest || 0, .5);
  // Exposed for diagnostics/tests, the same way `impostorMaterial.js` exposes
  // `userData.impostorAtlas`: identity-checkable without deep-comparing node
  // graphs (three's node materials are not diffable — see the file-level
  // warning above `createFoliageMaterial`'s sharing scheme).
  material.userData.foliageLod = lod;
  return material;
}

/**
 * ── ONE MATERIAL PER SHADER, NOT PER COMPONENT ────────────────────────────
 *
 * three keys programs on node IDENTITY (`Node.customCacheKey() → this.id`), so
 * two structurally identical materials built from two sets of freshly-minted
 * `uniform()` nodes compile TWO programs. `FoliageComponent` used to call
 * `createFoliageUniforms()` + `createFoliageMaterial()` per instance, and a
 * scene with eleven foliage components therefore compiled eleven copies of one
 * shader, each in vertex AND fragment, each again for the GI g-buffer and the
 * shadow pass.
 *
 * Measured on the user's Complex scene (2026-09-12, `profile.wgsl`): foliage
 * was **2 597 kB of the boot's 5 082 kB — 51 %** of every byte of WGSL handed
 * to the driver, with `Foliage · living surface` alone at 1 897 kB across
 * **30 distinct modules**. Vertex was the largest stage in the whole boot.
 *
 * ══ WHAT THE KEY HAS TO CONTAIN, AND WHY IT IS THIS SHORT ══════════════════
 *
 * SHAPE — `props.species`, and nothing else. `foliageAnimatedPosition`
 * (`foliageWind.js:235`) reads exactly one prop, `props.species` (via
 * `meadow`); `treeMotion` and every other branch come from
 * `builder.geometry.hasAttribute(...)`, which three already keys on, so two
 * components sharing this material but carrying different geometry still get
 * the programs they need. `createFoliageSurfaceMaterial` reads species for its
 * textures and for the one `leafRoughness` literal. Everything else in the wind
 * graph — strength, direction, time, speed, interaction, colliders, radius — is
 * already a uniform, not a baked constant.
 *
 * VALUES — every prop `updateFoliageUniforms` and `updateFoliageInteractions`
 * WRITE into the uniform object. Sharing a material means sharing its uniforms,
 * and two components in one bucket both write them every frame; they must write
 * the SAME numbers or the last writer would silently win. With these props in
 * the key they are identical writes, so the duplication is a no-op. (The
 * interaction field is already engine-global and shared by every component —
 * see `foliageInteraction.js` — so `props.interaction` is its only per-component
 * input.)
 *
 * A component whose props move OUT of its bucket simply acquires a different
 * one, which is the behaviour it had before: its own material.
 *
 * Refcounted like `releaseAtlas` above: the last release disposes. ⚠ Acquire
 * the new entry BEFORE releasing the old one, or a rebuild that lands on the
 * same key would dispose the material it is about to reuse.
 * `globalThis.__foliageShareMaterials = false` gives every component its own
 * material again (the A/B arm).
 */
const sharedMaterials = new Map();

/** The bucket a component belongs to: same key ⇒ same shader AND same uniform values. */
export function foliageMaterialKey(props = {}) {
  return [
    props.species,
    // `updateFoliageUniforms` inputs
    props.wind ? 1 : 0, props.windStrength, props.windGustStrength, props.windScale, props.windTurbulence,
    // `updateFoliageInteractions` + the interaction block's inputs
    props.interaction ? 1 : 0, props.interactionStrength, props.interactionRadius,
  ].join("|");
}

/**
 * Take a reference on the bucket for these props. Creates the UNIFORMS only —
 * the material stays lazy exactly as it was, because a component builds its
 * shader in `_rebuildShape`, not at construction.
 */
export function acquireFoliageEntry(props = {}) {
  const key = globalThis.__foliageShareMaterials === false
    ? `unshared:${sharedMaterials.size}:${Math.random()}`
    : foliageMaterialKey(props);
  let entry = sharedMaterials.get(key);
  if (!entry) {
    entry = { key, uniforms: createFoliageUniforms(), material: null, refs: 0 };
    sharedMaterials.set(key, entry);
  }
  entry.refs++;
  return entry;
}

/** The bucket's material, built on first use and shared by every holder. */
export function foliageEntryMaterial(entry, props = {}) {
  entry.material ??= createFoliageMaterial(entry.uniforms, props);
  return entry.material;
}

/** Drop a reference; the last one out disposes the shared material. */
export function releaseFoliageEntry(entry) {
  if (!entry || entry.refs <= 0) return;
  if (--entry.refs > 0) return;
  sharedMaterials.delete(entry.key);
  entry.material?.dispose();
  entry.material = null;
}

/**
 * ── THE SAME ARGUMENT FOR THE IMPOSTOR BAKE'S SOURCE MATERIAL ─────────────
 *
 * `acquireAtlas` caches the baked ATLAS on a twelve-prop key (seed, height,
 * colours, densities…) — correct, because those change the picture. But it
 * minted a fresh `createFoliageSurfaceMaterial(props)` for every entry, and
 * that function reads exactly ONE prop: `props.species` (its textures and the
 * single `leafRoughness` literal). Eleven components therefore baked through
 * eleven copies of one shader.
 *
 * It cost double, because `impostorBake.js` memoises its normal-pass material
 * PER SOURCE MATERIAL (`normalMaterials.set(sourceMaterial, …)`) — a fresh
 * source defeats that memo too. Measured 2026-09-12 with GI off:
 * `Foliage · surface` **44 modules for 6 distinct texts** and
 * `Impostor normal` **44 for 4** — ~80 redundant programs from one call.
 *
 * Keyed by species alone, refcounted, and PARKED (kept) by the last release —
 * see `releaseFoliageSurfaceMaterial`.
 */
const bakeMaterials = new Map();

/** The shared bake-source material for this species. */
export function acquireFoliageSurfaceMaterial(props = {}) {
  const key = globalThis.__foliageShareMaterials === false
    ? `unshared:${bakeMaterials.size}:${Math.random()}`
    : `species:${props.species}`;
  let entry = bakeMaterials.get(key);
  if (!entry) {
    entry = { key, material: createFoliageSurfaceMaterial(props), refs: 0 };
    bakeMaterials.set(key, entry);
  }
  entry.refs++;
  return entry;
}

/** Drop a reference on a bake-source material; the last one out disposes. */
export function releaseFoliageSurfaceMaterial(entry) {
  if (!entry || entry.refs <= 0) return;
  if (--entry.refs > 0) return;
  // ⭐ PARKED, NOT DISPOSED (09-14). Bakes run one at a time, so species-mates
  // requested a few frames apart never overlapped: the last release disposed
  // the shader and the next oak minted it again — a new `Foliage · surface`
  // and, through `impostorBake`'s per-source cache, a new `Impostor normal`
  // pipeline per bake. One material per species is a handful of objects for
  // the session; the unshared hatch keeps the old lifetime.
  if (!entry.key.startsWith("unshared:")) return;
  bakeMaterials.delete(entry.key);
  entry.material?.dispose();
  entry.material = null;
}

/** Receipt for the boot log and the tests: buckets, holders, and the collapse. */
export function foliageMaterialSharing() {
  let refs = 0;
  for (const entry of sharedMaterials.values()) refs += entry.refs;
  let bakeRefs = 0;
  for (const entry of bakeMaterials.values()) bakeRefs += entry.refs;
  return {
    buckets: sharedMaterials.size, components: refs,
    bakeBuckets: bakeMaterials.size, bakeHolders: bakeRefs,
  };
}

const passMaterials = new WeakMap();

function foliagePassMaterial(source, base) {
  let cache = passMaterials.get(source);
  if (!cache) {
    cache = new Map(); passMaterials.set(source, cache);
    const dispose = () => {
      for (const [original, entry] of cache) {
        original.removeEventListener("dispose", entry.dispose);
        entry.material.dispose();
      }
      cache.clear(); passMaterials.delete(source);
      source.removeEventListener("dispose", dispose);
    };
    source.addEventListener("dispose", dispose);
  }
  let entry = cache.get(base);
  if (!entry) {
    const material = base.clone();
    material.name = `${base.name} · Foliage`;
    const dispose = () => {
      material.dispose(); cache.delete(base);
      base.removeEventListener("dispose", dispose);
    };
    base.addEventListener("dispose", dispose);
    entry = { material, dispose }; cache.set(base, entry);
  }
  const material = entry.material;
  // Stable per (source, pass), independent of the draw order and Three's
  // shared override material version. Only an actual graph edit invalidates it.
  if (material.opacityNode !== source.opacityNode || material.normalNode !== source.normalNode || material.positionNode !== source.positionNode || material.side !== source.side || material.alphaTest !== source.alphaTest) {
    material.opacityNode = source.opacityNode;
    material.normalNode = source.normalNode;
    material.positionNode = source.positionNode;
    material.side = source.side;
    material.alphaTest = source.alphaTest;
    material.setupNormal = source.normalNode ? THREE.NodeMaterial.prototype.setupNormal : base.setupNormal;
    material.needsUpdate = true;
  }
  return material;
}

/** Three forwards positionNode into scene overrides, but not opacityNode,
 * normalNode or DoubleSide. Preserve the foliage surface in GI's position /
 * normal prepass: a billboard's transparent pixels must not become a wall.
 * A cached override per source material preserves stable shader identities. */
export function installFoliagePassHooks(mesh) {
  let saved = null;
  mesh.onBeforeRender = (_renderer, scene) => {
    const override = scene.overrideMaterial;
    if (!override?.isNodeMaterial || !override.name.startsWith("GI gbuffer")) return;
    saved = { scene, override };
    scene.overrideMaterial = foliagePassMaterial(mesh.material, override);
  };
  mesh.onAfterRender = () => {
    if (!saved) return;
    saved.scene.overrideMaterial = saved.override;
    saved = null;
  };
}

export function updateFoliageUniforms(uniforms, props, time, sceneWind = null) {
  const source = { ...SCENE_WIND_DEFAULTS, ...(sceneWind ?? {}) };
  const vector = windVector(source.vector);
  const force = Math.hypot(...vector);
  const gust = Math.max(0, Math.min(100, Number(source.gust) || 0));
  const total = force + gust;
  uniforms.time.value = time;
  uniforms.direction.value.set(...(force > 1e-6 ? vector : SCENE_WIND_DEFAULTS.vector)).normalize();
  // Scene wind is acceleration. The default 2 m/s² maps to unit response;
  // authored foliage knobs describe flexibility, never separate weather.
  uniforms.strength.value = props.wind ? Math.max(0, Number(props.windStrength) || 0) * total * .5 : 0;
  // ⭐⭐ THE WIND'S REACH, IN THE UNIT THE WEATHER SPEAKS: metres per second.
  //
  // `strength` is how HARD the wind pushes and it already scaled with the
  // scene wind — but every bend it drives saturates against a fixed cap, so
  // past a light breeze the extra force only made the same small motion arrive
  // sooner. A storm has to bend a tree FURTHER, not just faster. 1 at the
  // 2 m/s default (so every scene that never touches the weather looks exactly
  // as it did), 2.4 in the 7.5 m/s of a windy clear day, 4 in a gale.
  uniforms.reach.value = Math.min(4, .5 + total * .25);
  uniforms.speed.value = Math.max(0, Math.min(10, Number(source.gustFrequency) || 0));
  uniforms.gustStrength.value = Math.max(0, Number(props.windGustStrength ?? .6) || 0) * gust / Math.max(total, 1e-6);
  uniforms.gustScale.value = Math.max(.5, Number(props.windScale ?? 12) || 12);
  uniforms.turbulence.value = Math.max(0, Number(props.windTurbulence ?? .25) || 0);
  uniforms.interaction.value = props.interaction ? Math.max(0, Number(props.interactionStrength) || 0) : 0;
  uniforms.radius.value = Math.max(.01, Number(props.interactionRadius) || 1);
}
