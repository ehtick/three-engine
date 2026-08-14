// GI shared helpers that survived the SDF/voxel-bake deletion (2026-08-02).
//
// This file used to be the legacy CPU voxel medium (bakeCore rasterize + EDT
// + streaming bake worker). That pipeline is gone; what remains are the pure
// pieces the occupancy backend still consumes:
//   · resolveMaterialSurface / serializeMeshForBake — material → albedo/
//     emissive resolution and mesh serialization (GISystem, occupancy field).
//
// `createVoxelSceneTrace` (the TSL Amanatides-Woo DDA) and
// `createTrilinearRadianceSampler` (the side-aware trilinear field read every
// transport hit shaded through) lived here too and went with the SRC rebuild's
// §12.8/§12.9 cut: both READ the dense radiance buffers, and SRC has probes
// rather than a per-cell field, so neither has a successor to wait for.

/**
 * Evaluates a TSL node subtree to a constant RGB if possible, else null.
 * Handles ColorNode/uniform (.value Color), float constants (as grey),
 * constant ×/+ chains (the shader graph's `color × strength` emission), and
 * wrapper nodes (VarNode & co. keep the real expression in `.node` — this
 * three version auto-wraps operator chains in VarNode, which made every
 * graph-authored emissive look unresolvable and bake black).
 */
function constantColorOf(node, depth = 0) {
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

/** First THREE.Texture found in a node subtree (the shader graph's albedo
 *  sample), or null. Same bounded wrapper-walk as constantColorOf. */
function textureValueOf(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (node.value?.isTexture) return node.value;
  for (const child of [node.aNode, node.bNode, node.node]) {
    const found = child ? textureValueOf(child, depth + 1) : null;
    if (found) return found;
  }
  return null;
}

/**
 * Mean LINEAR color of a texture, from an 8×8 downsample of its source
 * image. This is what keeps a TEXTURED mesh from baking into the field —
 * and reflecting — as flat WHITE: the SDF slot carries one albedo, and
 * `material.color` for a textured model is white ("the reflection from a
 * model is white" report). GPU-compressed sources (KTX2) have no drawable
 * image → cached null → the scalar color fallback stands.
 */
const textureAverageCache = new WeakMap(); // texture -> {r,g,b} | null (tried, undrawable)

/**
 * COMPRESSED (KTX2/basis) textures cannot go through the canvas path below —
 * their `image` is not drawable, so for a compressed-textures project every
 * mesh's bounce albedo silently fell back to the material's base-color factor.
 * On glTF imports that factor is typically near-WHITE while the texture holds
 * the real color, and in an enclosed scene the error COMPOUNDS per bounce
 * (indirect ≈ direct·Ā/(1−Ā)): true Ā≈0.4 → ×0.67 fill, false Ā≈0.6+ →
 * ×1.6 — the whole interior brightens and desaturates. Live report
 * 2026-08-14, the user's banner Sponza: "washed out compared to before,
 * after I compressed the textures" — and it survived every post/shadow/sun
 * bisect because it lives inside the GI bounce.
 *
 * The GPU can sample what the canvas cannot draw (same fact the BVH atlas
 * blit is built on), so compressed textures queue here and GISystem's tick
 * renders each into a small target and calls `noteTextureAverage`. Returning
 * null UNCACHED is the same retry-next-scan contract as a not-yet-loaded
 * image: the fingerprint scan revisits, finds the cache filled, the palette
 * updates, and the normal reconcile re-uploads it.
 */
export const pendingTextureAverages = new Set();

/** GPU averager's completion callback — also the failure path (rgb = null
 *  caches the miss so the scalar fallback stands without re-queueing). */
export function noteTextureAverage(texture, rgb) {
  textureAverageCache.set(texture, rgb);
  pendingTextureAverages.delete(texture);
}
// Fingerprint scans revisit the same materials for the lifetime of a scene.
// A diagnostic that cannot change until the material graph changes should not
// flood the editor console/store on every scan.
const warnedUnresolvedEmissive = new WeakSet();
function textureAverageColor(texture) {
  if (!texture) return null;
  if (textureAverageCache.has(texture)) return textureAverageCache.get(texture);
  if (texture.isCompressedTexture) {
    // See pendingTextureAverages above — the GPU answers this one.
    pendingTextureAverages.add(texture);
    return null;
  }
  const image = texture.image;
  if (!image || !(image.width > 0) || !(image.height > 0)) return null; // not loaded yet — retry next scan
  if (image.complete === false) return null;
  try {
    // 128, not 8 (2026-08-04, Blender-parity): drawImage downsamples in sRGB
    // space, and an sRGB block-average decoded to linear UNDERESTIMATES the
    // true linear mean of the block (Jensen — a 50/50 black/white block reads
    // 0.21 instead of 0.5). At 8×8 each "texel" averaged an enormous block of
    // a contrasty texture, so every textured mesh's bounce albedo was biased
    // DARK and GRAY — compounding per bounce, which is a whole-room fill
    // deficit. At 128×128 the per-block variance (and so the bias) is small;
    // the per-texel decode below is unchanged. One-time cost per texture
    // (cached): a 64KB readback.
    const size = 128;
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(size, size)
        : Object.assign(document.createElement("canvas"), { width: size, height: size });
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      // Albedo images are sRGB-encoded — average in LINEAR, alpha-weighted.
      r += Math.pow(data[i] / 255, 2.2) * a;
      g += Math.pow(data[i + 1] / 255, 2.2) * a;
      b += Math.pow(data[i + 2] / 255, 2.2) * a;
      w += a;
    }
    const result = w > 1e-3 ? { r: r / w, g: g / w, b: b / w } : null;
    textureAverageCache.set(texture, result);
    return result;
  } catch {
    textureAverageCache.set(texture, null); // undrawable source — permanent
    return null;
  }
}

/**
 * Resolves the bake-relevant surface of a material. Engine material assets
 * carry their real color/emissive in colorNode/emissiveNode (top-level
 * `.color` can sit at stale white, `.emissive` at black) — same reason the
 * editor swatch walks colorNode. Texture-driven color multiplies in the
 * texture's MEAN color (see textureAverageColor).
 */
export function resolveMaterialSurface(materialInput, meshName = "") {
  const material = Array.isArray(materialInput) ? materialInput[0] : materialInput;
  const white = { r: 1, g: 1, b: 1 };
  const black = { r: 0, g: 0, b: 0 };
  let color = constantColorOf(material?.colorNode) ?? material?.color ?? white;
  // A/B escape hatch, dev/harness only.
  const mapAverage = globalThis.__giNoTextureTint
    ? null
    : textureAverageColor(material?.map ?? textureValueOf(material?.colorNode));
  if (mapAverage) {
    color = { r: color.r * mapAverage.r, g: color.g * mapAverage.g, b: color.b * mapAverage.b };
  }
  const emissiveTexture = textureValueOf(material?.emissiveNode);
  // An SDF slot stores ONE emissive color for the whole mesh. Replacing a
  // spatial mask with its average turns a building/room mesh into a giant
  // area light and washes every material toward white. Keep imported
  // texture-masked emission in the raster material only; GI emission remains
  // available for constant-color nodes and dedicated emissive geometry.
  const emissiveResolved = emissiveTexture ? null : constantColorOf(material?.emissiveNode);
  const emissive = emissiveResolved ?? material?.emissive ?? black;
  const emissiveIntensity = emissiveResolved ? 1 : (material?.emissiveIntensity ?? 1);
  // A texture-backed expression may simply be waiting for its image. Retry on
  // the next fingerprint scan without claiming that it is unsupported.
  if (material?.emissiveNode && !emissiveResolved && !emissiveTexture) {
    const fallbackDark =
      (emissive.r ?? 0) * emissiveIntensity < 0.01 &&
      (emissive.g ?? 0) * emissiveIntensity < 0.01 &&
      (emissive.b ?? 0) * emissiveIntensity < 0.01;
    if (fallbackDark && material && !warnedUnresolvedEmissive.has(material)) {
      warnedUnresolvedEmissive.add(material);
      console.warn(
        `[gi] "${meshName || "mesh"}": emissiveNode is not a constant color×intensity expression — ` +
          `this emitter bakes BLACK and won't light the GI. Use a flat emissive color/intensity, ` +
          `or report the graph shape so the resolver can learn it.`,
      );
    }
  }
  return { color, emissive, emissiveIntensity };
}

/**
 * Serializes a THREE.Mesh into the plain, structured-cloneable record
 * bakeCore consumes (safe to postMessage to the bake worker). Arrays are
 * copied — the live geometry stays untouched.
 */
const geometryCopyCache = new WeakMap(); // geometry -> { version, positions, index }

export function serializeMeshForBake(mesh) {
  const position = mesh.geometry?.attributes?.position;
  if (!position) return null;
  mesh.updateWorldMatrix(true, false);
  const surface = resolveMaterialSurface(mesh.material, mesh.name);
  // Vertex/index copies cached per geometry (big character models cost real
  // milliseconds to slice per request; a drag only changes the matrix).
  let cached = geometryCopyCache.get(mesh.geometry);
  const version = position.version ?? 0;
  if (!cached || cached.version !== version) {
    cached = {
      version,
      positions: position.array.slice(0, position.count * 3),
      index: mesh.geometry.index ? mesh.geometry.index.array.slice() : null,
    };
    geometryCopyCache.set(mesh.geometry, cached);
  }
  return {
    // Identity for the worker's incremental diffing + geometry cache: the
    // key changes when geometry content does, so edits re-ship exactly once.
    id: mesh.id,
    geometryKey: `${mesh.geometry.id}:${version}`,
    positions: cached.positions,
    index: cached.index,
    matrix: [...mesh.matrixWorld.elements],
    color: { r: surface.color.r, g: surface.color.g, b: surface.color.b },
    emissive: { r: surface.emissive.r, g: surface.emissive.g, b: surface.emissive.b },
    emissiveIntensity: surface.emissiveIntensity,
  };
}

const toRecords = (meshesOrRecords) =>
  meshesOrRecords.map((entry) => (entry?.isMesh ? serializeMeshForBake(entry) : entry)).filter(Boolean);

const toPlainLights = (light) => {
  const list = Array.isArray(light) ? light : light ? [light] : [];
  return list.map((entry) => ({
    type: entry.type === "directional" ? "directional" : "point",
    position: entry.position ? { x: entry.position.x, y: entry.position.y, z: entry.position.z } : undefined,
    direction: entry.direction
      ? { x: entry.direction.x, y: entry.direction.y, z: entry.direction.z }
      : undefined,
    color: { r: entry.color.r, g: entry.color.g, b: entry.color.b },
    intensity: entry.intensity,
  }));
};

/**
 * @param {Array} meshes THREE meshes OR pre-serialized bake records
 * @param {{min: THREE.Vector3, max: THREE.Vector3}} bounds
 * @param {{x: number, y: number, z: number}} res grid cells per axis
 * @param {object|Array} light light(s) for the direct bake
 */
// (voxelizeOnce — the legacy CPU whole-field voxel baker, its streaming
// bake worker and the mesh-SDF request worker — was deleted 2026-08-02 with
// the rest of the SDF pipeline. The pure helpers around it stay: material
// surface resolution, mesh serialization, the voxel DDA and the trilinear
// radiance sampler are all consumed by the occupancy backend.)
