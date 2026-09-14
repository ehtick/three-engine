import {
  diffuseColor, mix, normalView, normalWorld, positionViewDirection, pow, specularColor, specularF90, vec3,
} from "three/tsl";

/**
 * ── HOW LIGHT REACHES A LEAF CANOPY (09-14) ───────────────────────────────
 *
 * Shared by the living tree draw (`foliageMaterial.js`) and the far impostor
 * (`foliageWind.js#setupFoliageImpostorMaterial`), so the LOD handoff is a
 * detail change and never a brightness pop — the impostor used to get none of
 * this and read as a dark olive blot next to the tree it replaced.
 *
 *  - wrap: a crown is a soft volume, not a hard sphere; light wraps past the
 *    terminator instead of the shadow side going flat black at a low sun.
 *  - back: a thin leaf transmits the light hitting its far side (diffuse
 *    transmission), tinted yellow-green — light crossing chlorophyll is more
 *    saturated than light reflected off it.
 *  - forward: looking INTO the sun through the canopy, the leaves glow.
 *    `lightColor` already carries shadow visibility, so a leaf deep inside a
 *    shadowed crown stays dark; this never self-emits or feeds GI.
 *  - specularCut: a leaf is matte; roughness alone cannot stop Schlick's
 *    grazing Fresnel (three's direct GGX hard-codes f90 = 1), which put pale
 *    grey rims on every crown top seen against the light.
 *    ⭐⭐ 09-14 owner: "metallic colour blick on one side" — the cut was .85,
 *    and the leaf normal is the UNFLIPPED canopy normal, so on every card or
 *    crown side turned from the camera dotNV clamps to 0: V_GGX blows up and
 *    Schlick sits at f90. The 15% that survived still out-shone the dark
 *    albedo's diffuse (~0.9 vs ~0.6 at sun 20) — a white, view-dependent
 *    sheen. Now 1: no direct specular on leaves at all.
 *  - indirect specular: F0 and F90 go to 0 on leaves (`setupSpecular` below),
 *    so the sky/GI radiance never mirrors on a crown and its share returns to
 *    diffuse through three's energy term. ⛔ `material.envMapIntensity` was the
 *    09-13 attempt and did NOTHING: three reads it only when `material.envMap`
 *    is set — with `scene.environment` it uses `scene.environmentIntensity`.
 *  - ambient: the soft sky/ground hemisphere fill, kept from the original leaf
 *    model, so a crown's underside reads as ground-bounce and not as black.
 */
export const FOLIAGE_LEAF_LIGHT = Object.freeze({ wrap: .45, back: .35, forward: .6, specularCut: 1, ambient: .35 });

/** `leafWeight` is a float node: 1 on leaves, 0 on bark (1 for an impostor). */
export function installFoliageLeafLighting(material, leafWeight) {
  const baseSpecular = material.setupSpecular;
  if (baseSpecular) {
    material.setupSpecular = function (...args) {
      baseSpecular.apply(this, args);
      // Indirect only: its dielectric path reads these two. Direct GGX reads
      // `specularColorBlended` (not exported by three/tsl) — fully cut in `model.direct` below.
      const keep = leafWeight.oneMinus();
      specularColor.assign(specularColor.mul(keep));
      specularF90.assign(specularF90.mul(keep));
    };
  }
  const base = material.setupLightingModel;
  material.setupLightingModel = function (builder) {
    const model = base.call(this, builder);
    const { wrap, back, forward, specularCut, ambient } = FOLIAGE_LEAF_LIGHT;
    const direct = model.direct, indirect = model.indirect;
    // ⭐⭐ PIN THE VIEW-SPACE INPUTS ONCE, OUTSIDE THE PER-LIGHT CALLBACK —
    // `model.direct` runs once per light in its own stack, and a varying
    // referenced fresh from each re-triggers its vertex rebuild, leaking the
    // wind shader's raw attributes into the fragment stage ("Total fragment
    // input variables count exceeds the maximum", 09-13).
    const pinnedNormalView = normalView.toVar();
    const toCamera = positionViewDirection.toVar();
    const transmitTint = vec3(1, 1.12, .55);
    model.direct = function (light, directBuilder) {
      // `.assign` lands on the stack NOW, so this is the specular before this light.
      const specularBefore = vec3(0).toVar();
      specularBefore.assign(light.reflectedLight.directSpecular);
      direct.call(this, light, directBuilder);
      const dotNL = pinnedNormalView.dot(light.lightDirection);
      const wrapped = dotNL.add(wrap).div(1 + wrap).clamp(0, 1).sub(dotNL.clamp(0, 1)).max(0);
      const backLit = dotNL.negate().clamp(0, 1).mul(back);
      const intoLight = pow(toCamera.negate().dot(light.lightDirection).clamp(0, 1), 4).mul(forward);
      const leafLight = diffuseColor.rgb.mul(wrapped).add(diffuseColor.rgb.mul(transmitTint).mul(backLit.add(intoLight)));
      light.reflectedLight.directDiffuse.addAssign(light.lightColor.mul(leafLight).mul(leafWeight).div(Math.PI));
      light.reflectedLight.directSpecular.assign(mix(light.reflectedLight.directSpecular, specularBefore, leafWeight.mul(specularCut)));
    };
    model.indirect = function (indirectBuilder) {
      indirect.call(this, indirectBuilder);
      const { reflectedLight } = indirectBuilder.context;
      const upFactor = normalWorld.y.mul(.5).add(.5).clamp(0, 1);
      const hemisphere = mix(vec3(.24, .22, .15), vec3(.62, .68, .74), upFactor);
      reflectedLight.indirectDiffuse.addAssign(hemisphere.mul(diffuseColor.rgb).mul(leafWeight.mul(ambient)));
    };
    return model;
  };
  return material;
}
