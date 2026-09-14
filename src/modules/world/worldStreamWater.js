import * as THREE from 'three/webgpu';
import {
  attribute, cameraPosition, cameraViewMatrix, float, mix, normalWorldGeometry, positionWorld, transformDirection, uniform, vec2, vec3,
} from 'three/tsl';

/**
 * Material for streamed water (09-14, T6): lakes and rivers built per chunk by
 * `landscapeWater.js`. Same look as the World study water
 * (`worldWaterSurface.js`: depth absorption, fresnel over the scene IBL,
 * flow-advected ripples) but everything it needs rides on vertex attributes —
 * no domain/shore textures bound to one extent, so any chunk anywhere can use
 * the one shared material.
 */
export function createStreamedWaterMaterial({ style = 'natural' } = {}) {
  const time = uniform(0), natural = style === 'natural';
  const depth = attribute('waterDepth', 'float'), edge = attribute('waterEdge', 'float'), flow = attribute('waterFlow', 'vec2');
  const moving = flow.dot(flow).clamp(0, 1);
  const advected = positionWorld.xz.sub(flow.mul(time).mul(.24));
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
  const opticalDepth = depth.div(cosine.mul(.85).add(.15)).min(12);
  const absorbed = opticalDepth.mul(natural ? -.78 : -.64).exp().oneMinus();
  const shallowColor = vec3(new THREE.Color(natural ? '#756e49' : '#7c9c78'));
  const deepColor = vec3(new THREE.Color(natural ? '#142e2b' : '#205453'));
  const bodyColor = mix(shallowColor, deepColor, absorbed);
  const bodyOpacity = mix(float(.20), float(.90), absorbed);

  const material = new THREE.MeshPhysicalNodeMaterial({
    color: '#ffffff', metalness: 0, roughness: .12, ior: 1.333,
    transparent: true, depthWrite: false, side: THREE.FrontSide, transmission: 0, envMapIntensity: 1,
  });
  material.name = 'World streamed water';
  material.normalNode = transformDirection(cameraViewMatrix, worldNormal);
  material.colorNode = bodyColor.mul(fresnel.mul(.72).oneMinus());
  material.roughnessNode = moving.mul(.045).add(.085).add(fineVisibility.oneMinus().mul(.065));
  material.opacityNode = mix(bodyOpacity, float(.985), fresnel).mul(edge);
  material.userData.worldStreamedWater = { style };
  let disposed = false;
  return {
    material,
    update(seconds) { if (!disposed && Number.isFinite(seconds)) time.value = seconds; },
    dispose() { if (!disposed) { disposed = true; material.dispose(); } },
  };
}
