/** Shared, bounded inspection of the simple TSL node shapes emitted by the
 * engine material graph. These helpers deliberately do not try to evaluate
 * arbitrary shader code; they recover the classic material inputs needed by
 * CPU-side GI metadata and third-party renderers. */

/** A texture a plain `texture(tex)` node can sample with a vec2 UV. LAYERED
 * textures (DataArrayTexture — the architecture style surfaces, the uber
 * material — 3D and cube textures) need a layer/direction the CPU side cannot
 * know, and handing one to GI's shared 2D blit repointed its binding to a
 * `texture_2d_array` under a vec2 `textureSample`: an invalid WGSL module
 * that failed every pipeline sharing that source (2026-09-14, "a lot of
 * errors when enabling GI" on a scene with styled buildings). */
export function isFlatTexture(tex) {
  return !!tex?.isTexture && !isLayeredTexture(tex);
}

export function isLayeredTexture(tex) {
  return !!(tex?.isDataArrayTexture || tex?.isCompressedArrayTexture || tex?.isArrayTexture
    || tex?.isData3DTexture || tex?.isCubeTexture);
}

export function constantColorOf(node, depth = 0) {
  if (!node || depth > 8) return null;
  const value = node.value;
  if (value && typeof value === "object" && typeof value.r === "number") return value;
  if (typeof value === "number") return { r: value, g: value, b: value };
  if ((node.op === "*" || node.op === "+") && node.aNode && node.bNode) {
    const a = constantColorOf(node.aNode, depth + 1);
    const b = constantColorOf(node.bNode, depth + 1);
    if (a && b) {
      return node.op === "*"
        ? { r: a.r * b.r, g: a.g * b.g, b: a.b * b.b }
        : { r: a.r + b.r, g: a.g + b.g, b: a.b + b.b };
    }
  }
  if (node.node) return constantColorOf(node.node, depth + 1);
  return null;
}

export function textureValueOf(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (node.value?.isTexture) return isFlatTexture(node.value) ? node.value : null;
  for (const child of [node.aNode, node.bNode, node.node]) {
    const found = child ? textureValueOf(child, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

export function tintBesideTexture(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (node.op === "*" && node.aNode && node.bNode) {
    const aTex = !!textureValueOf(node.aNode);
    const bTex = !!textureValueOf(node.bNode);
    if (aTex !== bTex) return constantColorOf(aTex ? node.bNode : node.aNode);
  }
  if (node.node) return tintBesideTexture(node.node, depth + 1);
  return null;
}

export function constantFloatOf(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (typeof node.value === "number") return node.value;
  if (node.node) return constantFloatOf(node.node, depth + 1);
  return null;
}

/** Resolve the albedo that the engine's actual material shader reads. Node
 * materials commonly leave `.map = null` and `.color = white`; consumers that
 * inspect only the classic fields therefore produced white reflection holes. */
export function resolveMaterialAlbedo(material) {
  const colorNode = material?.colorNode;
  const map = (isFlatTexture(material?.map) ? material.map : null) ?? textureValueOf(colorNode);
  const tint = constantColorOf(colorNode)
    ?? tintBesideTexture(colorNode)
    ?? material?.color
    ?? { r: 1, g: 1, b: 1 };
  return { map, tint };
}
