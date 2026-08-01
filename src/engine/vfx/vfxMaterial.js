import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  cross,
  modelWorldMatrixInverse,
  normalize,
  positionLocal,
  texture as tslTexture,
  uniform,
  uv,
  vec3,
  vec4,
} from "three/tsl";

/**
 * Materials for the gameplay VFX primitives (roadmap item 13).
 *
 * Two shapes:
 *   - the RIBBON material, whose vertex stage turns a spine into a strip
 *     (line renderer, trail renderer),
 *   - the DECAL material, an ordinary surface that happens to be a clipped
 *     copy of the geometry it sits on.
 *
 * Both are node materials with the same handful of uniforms, exposed on
 * `material.userData.vfxUniforms` so a component can drive colour/opacity per
 * frame without rebuilding anything.
 *
 * Materials are per-component, not shared through a cache. Each one carries its
 * own texture, tint and blend mode, so a cache keyed on all of that would hold
 * roughly one entry per component anyway — and a shared material that a
 * component mutates is the bug this engine has already paid for once (see
 * MeshComponent's note about `.mat` instances).
 */

/** How the strip's width is oriented around the spine. */
export const RIBBON_ALIGNMENTS = ["view", "local"];

/**
 * The billboard, done in the vertex stage.
 *
 * `positionLocal` is the spine point; the strip's two vertices per point differ
 * only by `aSide` (-1/+1). The offset direction is perpendicular to both the
 * tangent and the view direction, which is what makes a ribbon read as a solid
 * band from any angle instead of disappearing when seen edge-on.
 *
 * Doing this here rather than on the CPU is what lets ONE geometry be correct
 * in the viewport, in the game view and in the shadow pass at the same time —
 * they are three different cameras drawing the same buffer in the same frame.
 */
function ribbonOffset(alignment, alignNormal) {
  const tangent = normalize(attribute("aTangent", "vec3"));
  const side = attribute("aSide", "float");
  const width = attribute("aWidth", "float");
  let axis;
  if (alignment === "local") {
    // Fixed plane: tyre tracks on the ground, a ribbon that must stay flat.
    axis = cross(tangent, alignNormal);
  } else {
    const cameraLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
    axis = cross(tangent, normalize(cameraLocal.sub(positionLocal)));
  }
  // The epsilon is load-bearing: looking straight down a ribbon (or aligning a
  // ribbon with its own plane normal) makes the cross product exactly zero, and
  // `normalize` of a zero vector is NaN — which does not produce a thin ribbon,
  // it produces no ribbon at all, intermittently, depending on where you stand.
  return normalize(axis.add(vec3(1e-6, 0, 0))).mul(side).mul(width.mul(0.5));
}

/**
 * Material for a ribbon strip.
 *
 * Unlit by design. A trail is almost always an emissive thing — a sword arc, a
 * rocket plume, a laser — and lighting a camera-facing strip means inventing a
 * normal for a surface that has none. Anything that genuinely needs to be lit
 * and to sit on a surface (tyre tracks, scorch marks, footprints) is a decal,
 * which has the real surface's normals.
 */
export function createRibbonMaterial({
  alignment = "view",
  blending = "alpha",
  map = null,
  color = 0xffffff,
  opacity = 1,
  depthWrite = false,
  alignNormal = [0, 1, 0],
} = {}) {
  const uniforms = {
    tint: uniform(new THREE.Color(color)),
    opacity: uniform(opacity),
    alignNormal: uniform(new THREE.Vector3(...alignNormal)),
  };

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    // A ribbon is a stack of overlapping transparent quads — writing depth
    // makes the near half of a curled trail erase the far half of itself.
    depthWrite,
    blending: blending === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.DoubleSide,
    toneMapped: blending !== "additive",
  });

  material.positionNode = positionLocal.add(ribbonOffset(alignment, uniforms.alignNormal));

  const vertexColor = attribute("aColor", "vec4");
  let rgb = vertexColor.rgb.mul(uniforms.tint);
  let alpha = vertexColor.a.mul(uniforms.opacity);
  if (map) {
    const texel = tslTexture(map, uv());
    rgb = rgb.mul(texel.rgb);
    alpha = alpha.mul(texel.a);
  }
  material.colorNode = vec4(rgb, alpha);
  material.userData.vfxUniforms = uniforms;
  material.userData.vfxAlignment = alignment;
  return material;
}

/**
 * Material for projected decals.
 *
 * Lit by default: a bullet hole that ignores the room's lighting reads as a
 * sticker, and unlike a ribbon a decal has real normals — they are the source
 * surface's, carried through the clipper.
 *
 * `depthWrite` is off and the geometry is nudged off the surface rather than
 * relying on `polygonOffset`: the offset is a rasterizer feature whose units
 * differ per backend, while a world-space epsilon behaves identically
 * everywhere and can be tuned by eye in the inspector.
 */
export function createDecalMaterial({
  map = null,
  color = 0xffffff,
  opacity = 1,
  lit = true,
  blending = "alpha",
  roughness = 0.9,
  metalness = 0,
} = {}) {
  const uniforms = {
    tint: uniform(new THREE.Color(color)),
    opacity: uniform(opacity),
  };
  const MaterialClass = lit ? THREE.MeshStandardNodeMaterial : THREE.MeshBasicNodeMaterial;
  const material = new MaterialClass({
    transparent: true,
    depthWrite: false,
    blending: blending === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: THREE.FrontSide,
    toneMapped: blending !== "additive",
  });
  if (lit) {
    material.roughness = roughness;
    material.metalness = metalness;
  }

  // Per-decal fade lives in the vertex colour, so one buffer can hold decals at
  // different ages and a fading decal costs one small sub-range upload rather
  // than a material per decal.
  const vertexColor = attribute("color", "vec4");
  let rgb = vertexColor.rgb.mul(uniforms.tint);
  let alpha = vertexColor.a.mul(uniforms.opacity);
  if (map) {
    const texel = tslTexture(map, uv());
    rgb = rgb.mul(texel.rgb);
    alpha = alpha.mul(texel.a);
  }
  if (lit) {
    material.colorNode = vec4(rgb, 1);
    material.opacityNode = alpha;
  } else {
    material.colorNode = vec4(rgb, alpha);
  }
  material.userData.vfxUniforms = uniforms;
  return material;
}

/**
 * Applies the wrap mode a ribbon's texture mode implies.
 *
 * "tile" drives u past 1 (that is the whole point — one repeat per N metres, so
 * a long trail isn't one smeared texture), and the default clamp turns
 * everything past the first repeat into a stretched edge pixel. Textures from
 * `loadTextureAsset` are freshly created per call, so this is safe to set.
 */
export function applyRibbonWrap(texture, textureMode) {
  if (!texture) return texture;
  texture.wrapS = textureMode === "tile" ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}
