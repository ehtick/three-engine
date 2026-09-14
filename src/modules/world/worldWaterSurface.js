import * as THREE from 'three/webgpu';
import {
  cameraPosition, cameraViewMatrix, float, mix, normalWorldGeometry, positionWorld, positionLocal,
  texture, transformDirection, uniform, vec2, vec3,
} from 'three/tsl';

/** Phase 0 pond/river appearance, using the scene's real atmospheric IBL.
 * Borrowed fields cover [-extent/2, extent/2] in world X/Z, row 0 = min Z:
 * domain RGBA = surface Y, nominal bed Y, flow X/Z (finite dry sentinel);
 * shore RGBA = signed distance (dry positive), ACTUAL bed depth, flow X/Z.
 *
 * The terrain remains visible through ordinary alpha blending in shallows;
 * depth tint approximates absorption, without refracting a background image.
 * There is no local geometry reflection capture, underwater view or physical
 * light transport here. Sky reflection is native dielectric environment IBL.
 * All work is bounded: five level-0 field taps, three analytic ripple bands,
 * one shared time uniform, no new textures, render targets or storage buffers.
 */
export function createStudyWaterSurface({ domainTexture, shoreTexture, style = 'natural', extent = 128, localDomain = false } = {}) {
  for (const [name, field] of Object.entries({ domainTexture, shoreTexture })) {
    if (!field?.isTexture || !(field.image?.width > 0) || !(field.image?.height > 0)) {
      throw new TypeError(`${name} must be a populated field texture`);
    }
  }
  if (!Number.isFinite(extent) || extent <= 0) throw new RangeError('water extent must be finite and positive');
  const time = uniform(0), natural = style === 'natural';
  const worldUV = (localDomain ? positionLocal : positionWorld).xz.div(extent).add(.5);
  const field = texture(domainTexture, worldUV).level(0);

  // Explicit bilinear reconstruction works with nearest Float32 textures on
  // portable devices; it never requests the optional float32-filterable feature.
  // Sampling texel centres also gives the same result with a linear sampler.
  const dimensions = vec2(shoreTexture.image.width, shoreTexture.image.height);
  const pixel = worldUV.mul(dimensions).sub(.5), base = pixel.floor(), blend = pixel.fract();
  const tap = (x, y) => texture(shoreTexture, base.add(vec2(x + .5, y + .5))
    .clamp(vec2(.5), dimensions.sub(.5)).div(dimensions)).level(0);
  const shore = mix(mix(tap(0, 0), tap(1, 0), blend.x), mix(tap(0, 1), tap(1, 1), blend.x), blend.y);
  const depth = shore.g.max(0), wetDistance = shore.r.negate();
  const edge = wetDistance.smoothstep(0, .18);
  const valid = field.r.greaterThan(-99999);
  // Prefer the interpolated flow at mouths; a nearest valid domain read keeps
  // the original reach direction when only its shoreline sample is dry.
  const flow = mix(valid.select(field.ba, vec2(0)), shore.ba, wetDistance.smoothstep(0, .35));
  const moving = flow.dot(flow).clamp(0, 1);
  const advected = positionWorld.xz.sub(flow.mul(time).mul(.24));
  // Slowly varying phase offsets break up ruler-straight parallel crests.
  // Sheltered pond ripples stay shallow; the river adds its own flow response.
  const distortion = advected.dot(vec2(.17, -.13)).add(time.mul(.09)).sin().mul(1.6)
    .add(advected.dot(vec2(-.11, .23)).sub(time.mul(.07)).sin().mul(.9));
  const phaseA = advected.dot(vec2(1.9, .72)).add(distortion).sub(time.mul(.72));
  const phaseB = advected.dot(vec2(-.83, 2.75)).sub(distortion.mul(.73)).add(time.mul(.95));
  const phaseC = advected.dot(vec2(6.7, -3.8)).sub(time.mul(1.45));
  const footprint = positionWorld.xz.dFdx().length().max(positionWorld.xz.dFdy().length());
  const fineVisibility = footprint.smoothstep(.06, .32).oneMinus();
  const slope = vec2(1.9, .72).mul(phaseA.cos()).mul(.0045)
    .add(vec2(-.83, 2.75).mul(phaseB.cos()).mul(.003))
    .add(vec2(6.7, -3.8).mul(phaseC.cos()).mul(.0015).mul(fineVisibility))
    .mul(depth.smoothstep(0, .3)).mul(moving.mul(.45).add(1));
  const worldNormal = normalWorldGeometry.add(vec3(slope.x.negate(), 0, slope.y.negate())).normalize();
  const cosine = cameraPosition.sub(positionWorld).normalize().dot(worldNormal).abs().clamp(0, 1);
  const fresnel = cosine.oneMinus().pow(5).mul(.97963).add(.02037);
  // Longer oblique paths hide the bed progressively, while the shoreline's
  // actual shallow depth remains clear. This is an appearance approximation.
  const opticalDepth = depth.div(cosine.mul(.85).add(.15)).min(12);
  const absorbed = opticalDepth.mul(natural ? -.78 : -.64).exp().oneMinus();
  const shallowColor = vec3(new THREE.Color(natural ? '#756e49' : '#7c9c78'));
  const deepColor = vec3(new THREE.Color(natural ? '#142e2b' : '#205453'));
  const bedVariation = positionWorld.x.mul(.74).add(positionWorld.z.mul(.31)).sin()
    .mul(positionWorld.z.mul(.61).sub(positionWorld.x.mul(.22)).sin()).mul(.035).add(1);
  const bodyColor = mix(shallowColor.mul(bedVariation), deepColor, absorbed);
  const bodyOpacity = mix(float(.20), float(.90), absorbed);

  const material = new THREE.MeshPhysicalNodeMaterial({
    color: '#ffffff', metalness: 0, roughness: .12, ior: 1.333,
    transparent: true, depthWrite: false, side: THREE.FrontSide,
    transmission: 0, envMapIntensity: 1,
  });
  material.name = 'World study · depth and reflective water';
  material.normalNode = transformDirection(cameraViewMatrix, worldNormal);
  material.colorNode = bodyColor.mul(fresnel.mul(.72).oneMinus());
  material.roughnessNode = moving.mul(.045).add(.085)
    .add(fineVisibility.oneMinus().mul(.065)).add(wetDistance.smoothstep(0, .6).oneMinus().mul(.055));
  material.opacityNode = mix(bodyOpacity, float(.985), fresnel).mul(edge);
  // Signed-distance coverage produces one coherent narrow edge. The geometry
  // and exact packed domain retain the same elevations and river/lake joins.
  material.maskNode = shore.r.lessThan(0).and(worldUV.x.greaterThanEqual(0)).and(worldUV.x.lessThanEqual(1))
    .and(worldUV.y.greaterThanEqual(0)).and(worldUV.y.lessThanEqual(1));
  material.maskShadowNode = material.maskNode;
  material.userData.worldStudyWater = { style, extent, shorelineFeather: .18,
    reflection: 'scene environment IBL', refraction: 'none; alpha blended bed', fieldTextureTaps: 5 };
  let disposed = false;
  return {
    material,
    update(seconds) { if (!disposed && Number.isFinite(seconds)) time.value = seconds; },
    dispose() { if (!disposed) { disposed = true; material.dispose(); } },
  };
}
