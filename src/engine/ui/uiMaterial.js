import * as THREE from "three/webgpu";
import {
  uniform,
  uv,
  vec2,
  step,
  mix,
  fract,
  texture as tslTexture,
  screenCoordinate,
} from "three/tsl";
import { SDF_EDGE } from "./sdfFont.js";

/**
 * TSL node materials for UI quads. Every UI material is transparent,
 * painter's-ordered (renderOrder, not depth) and carries a screen-space clip
 * rect uniform (physical pixels, y-down top-left origin) so masks/scroll views
 * clip without stencil buffers.
 *
 * The uniforms object returned alongside each material is what the UiSystem
 * writes into every layout pass — `material.userData.uiUniforms`.
 */

const HUGE_CLIP = [-1e7, -1e7, 1e7, 1e7];

function makeBaseUniforms() {
  return {
    clip: uniform(new THREE.Vector4(...HUGE_CLIP)),
    alpha: uniform(1), // element opacity × inherited opacity
  };
}

/** 1 where the fragment is inside the clip rect, 0 outside. */
function clipFactor(clipUniform) {
  const sc = screenCoordinate;
  return step(clipUniform.x, sc.x)
    .mul(step(sc.x, clipUniform.z))
    .mul(step(clipUniform.y, sc.y))
    .mul(step(sc.y, clipUniform.w));
}

function configureUiMaterial(material) {
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  material.toneMapped = false;
}

/**
 * Antialiasing width for a distance expressed in UI pixels: how much that
 * distance changes across one screen pixel.
 *
 * This used to be a CPU-computed uniform (1/k — one physical pixel in UI px),
 * which is only correct for a screen-space overlay where the quad's on-screen
 * size is known at layout time. A world-space panel's on-screen size depends on
 * where the camera is, so the same uniform gave a razor-hard edge up close and a
 * blurred smear at distance. Reading it from the fragment derivative is right in
 * both cases and costs nothing.
 *
 * The floor matters: a quad seen edge-on has an enormous derivative, and without
 * a clamp the whole panel dissolves into a uniform grey haze instead of
 * vanishing.
 */
const aaWidth = (distance) => distance.fwidth().max(1e-4);

/**
 * One axis of a nine-slice UV remap.
 *
 * `coord` is 0..1 across the quad, `size` the quad's extent in UI px, `texSize`
 * the texture's extent in px, and `near`/`far` the border insets in texture px.
 * Corners keep their pixel size while the middle stretches — the point of the
 * whole exercise, since a stretched 8px rounded corner is the giveaway that a
 * panel was scaled.
 *
 * Branchless (two `step`s and two `mix`es) rather than `If`: this runs per
 * fragment, and both branches are two multiply-adds.
 */
function sliceAxis(coord, size, texSize, near, far, tile) {
  const p = coord.mul(size); // position along the quad, in UI px
  const innerQuad = size.sub(near).sub(far).max(0.0001);
  const innerTex = texSize.sub(near).sub(far).max(0.0001);
  const local = p.sub(near);
  // Stretched middle, or repeated at the texture's own pixel size.
  const middle = tile
    ? near.add(fract(local.div(innerTex)).mul(innerTex))
    : near.add(local.div(innerQuad).mul(innerTex));
  const inFar = step(size.sub(far), p);
  const inNear = step(p, near);
  // Far region measured back from the edge so the right/bottom border keeps
  // its pixels; near region wins on a quad too small to hold both borders.
  const texel = mix(mix(middle, texSize.sub(size.sub(p)), inFar), p, inNear);
  return texel.div(texSize);
}

/**
 * Image/panel material: SDF rounded rect with optional border, optional
 * texture (simple, nine-slice or tiled), optional fill cutoff (progress bars).
 *
 * The node graph shape depends on `options` — rebuild the material when
 * texture presence, slicing or fillMode changes; everything else is a uniform
 * update.
 *
 * options: { texture?, fillMode?: "none"|"horizontal"|"vertical",
 *            imageType?: "simple"|"sliced"|"tiled" }
 */
export function createUiImageMaterial(options = {}) {
  const u = {
    ...makeBaseUniforms(),
    color: uniform(new THREE.Color(1, 1, 1)),
    tint: uniform(new THREE.Color(1, 1, 1)), // runtime-only (button states)
    size: uniform(new THREE.Vector2(100, 100)), // rect size in UI px
    radius: uniform(0), // corner radius in UI px (clamped CPU-side)
    borderWidth: uniform(0),
    borderColor: uniform(new THREE.Color(0, 0, 0)),
    fillAmount: uniform(1),
    // Nine-slice: the texture's pixel size and the four insets into it.
    texSize: uniform(new THREE.Vector2(1, 1)),
    slice: uniform(new THREE.Vector4(0, 0, 0, 0)), // left, right, top, bottom
  };

  // Signed distance to a rounded rect, in UI pixels. uv() is 0..1 across the
  // quad; the SDF is symmetric so uv y-orientation doesn't matter.
  const p = uv().sub(0.5).mul(u.size);
  const q = p.abs().sub(u.size.mul(0.5)).add(u.radius);
  const dist = q.max(0).length().add(q.x.max(q.y).min(0)).sub(u.radius);
  const aa = aaWidth(dist);
  const shape = dist.negate().div(aa).add(0.5).clamp(0, 1);
  // 1 inside the border ring's inner edge, 0 at it — mixes fill vs border.
  const innerFactor = dist.add(u.borderWidth).negate().div(aa).add(0.5).clamp(0, 1);

  let rgb = mix(u.borderColor, u.color, innerFactor).mul(u.tint);
  let alpha = u.alpha.mul(shape).mul(clipFactor(u.clip));

  if (options.texture) {
    const sliced = options.imageType === "sliced" || options.imageType === "tiled";
    const tile = options.imageType === "tiled";
    const coord = sliced
      ? vec2(
          sliceAxis(uv().x, u.size.x, u.texSize.x, u.slice.x, u.slice.y, tile),
          sliceAxis(uv().y, u.size.y, u.texSize.y, u.slice.z, u.slice.w, tile),
        )
      : uv();
    const texel = tslTexture(options.texture, coord);
    rgb = rgb.mul(texel.rgb);
    alpha = alpha.mul(texel.a);
  }
  if (options.fillMode === "horizontal") {
    alpha = alpha.mul(step(uv().x, u.fillAmount));
  } else if (options.fillMode === "vertical") {
    alpha = alpha.mul(step(uv().y, u.fillAmount));
  }

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = rgb;
  material.opacityNode = alpha;
  configureUiMaterial(material);
  material.userData.uiUniforms = u;
  return material;
}

/**
 * Raster text material: colour and alpha come straight from the
 * canvas-rendered texture (text colour is baked into the canvas for correct
 * subpixel blends). See sdfText.js for the resolution-independent path.
 */
export function createUiTextMaterial(canvasTexture) {
  const u = makeBaseUniforms();
  const texel = tslTexture(canvasTexture);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = texel.rgb;
  material.opacityNode = texel.a.mul(u.alpha).mul(clipFactor(u.clip));
  configureUiMaterial(material);
  material.userData.uiUniforms = u;
  return material;
}

/**
 * SDF text material. The atlas stores a signed distance in its red channel,
 * `0.5` being the glyph edge, so the coverage of a fragment is a smoothstep
 * whose width is the derivative of that distance — which is what makes the
 * same texture sharp at 8px and at 800px.
 *
 * An outline is nearly free here: it is the same field thresholded further
 * out, drawn behind the fill. Outlined text is what makes a HUD readable over
 * arbitrary scenery, and doing it with a second rasterized copy (the usual
 * canvas trick) costs a second texture and never lines up under scaling.
 */
export function createUiSdfTextMaterial(atlasTexture) {
  const u = {
    ...makeBaseUniforms(),
    color: uniform(new THREE.Color(1, 1, 1)),
    outlineColor: uniform(new THREE.Color(0, 0, 0)),
    // In distance-field units — see SDF_EDGE in sdfFont.js for why the glyph
    // edge is not at 0.5.
    outlineWidth: uniform(0),
    // Shifts the threshold: fattens or thins the glyph. A cheap fake bold, and
    // the knob that rescues a hairline font at small sizes.
    weightBias: uniform(0),
    edge: uniform(SDF_EDGE),
  };
  const texel = tslTexture(atlasTexture);
  const d = texel.r;
  // Coverage width from the derivative of the field itself.
  const w = aaWidth(d);
  const edge = u.edge.sub(u.weightBias);
  const fill = d.sub(edge).div(w).add(0.5).clamp(0, 1);
  const outer = d.sub(edge.sub(u.outlineWidth)).div(w).add(0.5).clamp(0, 1);

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = mix(u.outlineColor, u.color, fill);
  // `outer` is the silhouette including the outline; `fill` picks the colour
  // inside it. With outlineWidth 0 the two collapse to the same edge.
  material.opacityNode = outer.mul(u.alpha).mul(clipFactor(u.clip));
  configureUiMaterial(material);
  material.userData.uiUniforms = u;
  return material;
}

/** Writes the shared per-element uniforms (clip in physical px, opacity). */
export function applyElementUniforms(material, { clipRect, alpha, k, depthTest = false }) {
  const u = material.userData.uiUniforms;
  if (!u) return;
  if (clipRect) {
    u.clip.value.set(clipRect.x * k, clipRect.y * k, (clipRect.x + clipRect.w) * k, (clipRect.y + clipRect.h) * k);
  } else {
    u.clip.value.set(...HUGE_CLIP);
  }
  u.alpha.value = alpha;
  // World-space panels can be occluded by scene geometry; an overlay never is.
  // Assigning only on change keeps WebGPU from rebuilding the pipeline every
  // frame (the flag is part of the pipeline key).
  if (material.depthTest !== depthTest) material.depthTest = depthTest;
}
