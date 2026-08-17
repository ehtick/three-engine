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
 * The CONSTANT SCALE multiplying a texture inside a node subtree — the
 * `strength` half of the shader graph's `emissive = colorInput × strength`.
 *
 * ⚠ THIS IS WHY "NO MATTER WHAT NUMBER I SET, IT EMITS NO LIGHT" (2026-08-17,
 * the user's Bistro lanterns, five sessions).
 *
 * `tslGraph` builds `m.emissiveNode = mul(colorInput, strength)`. When the
 * colour input is a flat swatch the whole product folds and `constantColorOf`
 * returns it — that path works and always has. When the colour input is a
 * TEXTURE the product cannot fold, and the emissive resolver below refused it
 * outright: the mesh baked BLACK and `emissiveStrength` was multiplying a node
 * GI never evaluated. Every value produced exactly the same darkness, which is
 * indistinguishable from a broken transport and is why this was chased through
 * the transport four times.
 *
 * `material.emissiveIntensity` cannot stand in for it — the strength is baked
 * INTO the node by that `mul`, so the material's own field sits at its default
 * of 1. The number has to be recovered from the graph, which is what this does:
 * walk the product, and where one side is a texture, fold the other side.
 */
function textureScaleOf(node, depth = 0) {
  if (!node || depth > 8) return 1;
  if (node.op === "*" && node.aNode && node.bNode) {
    const aTex = !!textureValueOf(node.aNode);
    const bTex = !!textureValueOf(node.bNode);
    // Exactly one side carries the texture: the other side IS the scale.
    if (aTex !== bTex) {
      const scaleSide = aTex ? node.bNode : node.aNode;
      const texSide = aTex ? node.aNode : node.bNode;
      const c = constantColorOf(scaleSide);
      // Channel mean: `strength` is authored as a float, so a vec3 here is a
      // colour tint and its mean is the right scalar to carry.
      const s = c ? (c.r + c.g + c.b) / 3 : 1;
      return s * textureScaleOf(texSide, depth + 1);
    }
  }
  for (const child of [node.aNode, node.bNode, node.node]) {
    if (!child) continue;
    if (textureValueOf(child)) return textureScaleOf(child, depth + 1);
  }
  return 1;
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
const warnedEmissiveMask = new WeakSet();
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
  // ── BOUNCE CHROMA vs TWO KNOWN APPROXIMATION ERRORS ──────────────────────
  //
  // This ONE colour is the entire bounce answer for every ray that lands on
  // this mesh, and two approximations inflate its chroma in places the
  // physics would not:
  //
  //   · ONE AVERAGE PER MESH. A shopfront whose texture is blue paint +
  //     white trim + glass bounces the AVERAGE over its whole area, so the
  //     blue is delivered by the trim and the glass too.
  //   · SHARED CELLS. Thin geometry shares a voxel cell — and therefore one
  //     surface record and one colour — with whatever is behind it (the live
  //     Bistro reports 373 of 636 meshes thinner than 2 cells), so an
  //     awning's red or a sign's blue is stamped onto the wall behind it.
  //
  // Both errors are chroma errors, not energy errors, and they are what the
  // user sees as saturated blotches on neutral stone ("dirty colors",
  // 2026-08-16). Damping chroma toward the colour's own LUMINANCE corrects
  // in the direction of the known error while preserving how much light
  // bounces — the physical quantity the estimator does get right.
  //
  // Default 1 = untouched: this ships as a measured choice, not a silent
  // one. `__giBounceSaturation` is the live dial — the fingerprint hashes
  // this colour, so changing it re-tints the palette on the next scan with
  // NO rebuild and no compile wave (plan §13.7b).
  const bounceSat = globalThis.__giBounceSaturation;
  if (Number.isFinite(bounceSat) && bounceSat < 1) {
    const s = Math.max(0, bounceSat);
    const lum = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    color = {
      r: lum + (color.r - lum) * s,
      g: lum + (color.g - lum) * s,
      b: lum + (color.b - lum) * s,
    };
  }
  const emissiveTexture = textureValueOf(material?.emissiveNode);
  // ── A TEXTURE-DRIVEN EMISSIVE NOW RESOLVES TO ITS MEAN × STRENGTH ────────
  //
  // This used to be `emissiveTexture ? null : …` — a flat refusal — on this
  // argument, which is quoted because half of it is still right:
  //
  //   "An SDF slot stores ONE emissive color for the whole mesh. Replacing a
  //    spatial mask with its average turns a building/room mesh into a giant
  //    area light and washes every material toward white."
  //
  // The SPATIAL half is true: one colour per mesh cannot represent lit windows
  // in a dark facade, and the average spreads their glow over the whole wall.
  // The ENERGY half is backwards. Emitted power is `∫ radiance dA = area ×
  // mean(radiance)`, so the mean is exactly the energy-correct summary — it is
  // the same identity `textureAverageColor` is already trusted for on the
  // BOUNCE ALBEDO two dozen lines above, where getting it wrong compounded per
  // bounce and washed out a whole interior (§2026-08-14).
  //
  // And the refusal's own failure mode is far worse than the wash it avoided:
  // the emitter baked BLACK, so an authored lantern emitted NOTHING at any
  // strength, silently — the warning below was gated on `!emissiveTexture`, so
  // a textured emissive did not even get a diagnostic. Measured on the user's
  // Bistro: `Lantern.mat` at `emissiveStrength: 1500` delivered rgb 0/0/0, and
  // 1, 100 and 1000 were indistinguishable. Five sessions went into the
  // transport looking for it.
  //
  // A wash in the right ballpark beats a confident zero. The spatial error is
  // real and is now SAID OUT LOUD (the coverage warning below) rather than
  // avoided by emitting nothing.
  const emissiveTexAvg = emissiveTexture && !globalThis.__giNoEmissiveTexture
    ? textureAverageColor(emissiveTexture)
    : null;
  let emissiveResolved = emissiveTexture ? null : constantColorOf(material?.emissiveNode);
  let emissiveIntensity = emissiveResolved ? 1 : (material?.emissiveIntensity ?? 1);
  if (!emissiveResolved && emissiveTexAvg) {
    // The graph's `strength` is baked into `emissiveNode` by tslGraph's `mul`,
    // so it comes from the node, never from `material.emissiveIntensity` —
    // see `textureScaleOf`.
    emissiveResolved = emissiveTexAvg;
    emissiveIntensity = textureScaleOf(material.emissiveNode);
  }
  const emissive = emissiveResolved ?? material?.emissive ?? black;
  // A texture-backed expression may simply be waiting for its image. Retry on
  // the next fingerprint scan without claiming that it is unsupported.
  // A textured emissive whose image has not decoded yet resolves to null and
  // retries on the next scan — but a COMPRESSED one queues on the GPU averager
  // and could sit unresolved indefinitely if that path ever breaks. Say so once,
  // because the symptom (an emitter that emits nothing) is the exact thing this
  // whole block exists to stop being silent.
  if (emissiveTexture && !emissiveTexAvg && material && !warnedUnresolvedEmissive.has(material)) {
    warnedUnresolvedEmissive.add(material);
    console.warn(
      `[gi] "${meshName || "mesh"}": emissive is TEXTURE-DRIVEN and its average is not resolved yet ` +
        `(${emissiveTexture.isCompressedTexture ? "compressed — queued for the GPU averager" : "image still loading"}). ` +
        `The emitter is dark until it lands; if this line never stops repeating across rebuilds, the average never ` +
        `arrived and the lamp will emit nothing at any strength.`,
    );
  }
  // ── AND WHERE THE MEAN IS A POOR SUMMARY, SAY THAT TOO ───────────────────
  //
  // Low coverage = a MASK (dark texture, small bright region), which is the
  // case the old refusal was protecting against: the mean spreads a window's
  // glow over the whole facade. The energy is right, the distribution is not.
  // Naming it is what lets someone split the mesh or use a flat emissive on the
  // lit part instead of discovering the wash by eye.
  if (emissiveTexture && emissiveTexAvg && material && !warnedEmissiveMask.has(material)) {
    const lum = 0.2126 * emissiveTexAvg.r + 0.7152 * emissiveTexAvg.g + 0.0722 * emissiveTexAvg.b;
    if (lum > 0 && lum < 0.12) {
      warnedEmissiveMask.add(material);
      console.warn(
        `[gi] "${meshName || "mesh"}": emissive texture is mostly dark (mean luminance ${lum.toFixed(3)}) — GI carries ` +
          `ONE emissive colour per mesh, so its lit region's glow is spread over the whole mesh. Total emitted power is ` +
          `correct; its placement is not. Split the emissive geometry into its own mesh for a crisp light.`,
      );
    }
  }
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
