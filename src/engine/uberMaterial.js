// @ts-check
import * as THREE from "three/webgpu";
import { attribute, normalMap, texture, uniformArray, vec2, vec3, vec4 } from "three/tsl";

/**
 * One material for many materials.
 *
 * Static merging (see `merging.js`) can concatenate any number of geometries
 * into one buffer, but a single draw call can bind exactly one material — so the
 * merge is only worth anything if the materials collapse too. They cannot be
 * collapsed by picking one: what actually differs between two Sponza materials
 * is which texture they bind and a handful of scalars.
 *
 * So this builds the material the merged geometry needs: every source texture
 * becomes a LAYER of a `DataArrayTexture`, every source scalar becomes an entry
 * in a small uniform array, and the merged geometry carries a per-vertex
 * `materialIndex` that selects both. N bind groups become one.
 *
 * ## Layers are not resampled
 *
 * A texture array demands one size for every layer, and rescaling a source map
 * to fit is a visible change to the user's art. This module therefore never
 * rescales: a group is formed only from materials whose textures already agree
 * on size and wrapping (`slotSignature` is what enforces it), and the caller
 * splits mismatched ones into separate groups. The one image this module
 * synthesises is the neutral fill for a material that has no texture in a slot
 * its group-mates do use — white for colour, flat +Z for normals — which is
 * exactly the value the shader would have used anyway.
 *
 * ## Only stock PBR
 *
 * `isUberCompatible` refuses any material carrying a custom node slot. A
 * node-graph material's colour is an arbitrary expression, and there is no
 * "index" that could select between two of them — the only materials whose
 * differences are DATA rather than CODE are the stock-PBR ones that
 * `materialAsset.js` produces for imported PBR (`applyStockPbr`). Those are the
 * 32-of-46 same-structure imports that made this worth building.
 */

/**
 * Node slots that turn a material's shading into code rather than data. Any one
 * of them present means this material cannot be expressed as a row in a table.
 *
 * `giMonitorNode` is deliberately absent: the GI module hangs it on every
 * material as an inert marker (it only needs SOME own property with `.isNode`
 * so three's observer refreshes uniforms every frame), and it contributes
 * nothing to the shading graph. Treating it as a custom slot would make every
 * material in a GI scene unmergeable — which is every scene this exists for.
 */
const CUSTOM_NODE_SLOTS = [
  "colorNode",
  "opacityNode",
  "alphaTestNode",
  "normalNode",
  "positionNode",
  "depthNode",
  "emissiveNode",
  "roughnessNode",
  "metalnessNode",
  "clearcoatNode",
  "sheenNode",
  "iridescenceNode",
  "transmissionNode",
  "aoNode",
  "envNode",
  "backdropNode",
  "outputNode",
  "fragmentNode",
  "vertexNode",
  "geometryNode",
  "castShadowNode",
];

/** Texture slots this uber material knows how to express. */
export const UBER_SLOTS = ["map", "normalMap"];

/**
 * True when `material` is a stock-PBR surface whose whole appearance is
 * scalars plus the slots in `UBER_SLOTS`.
 */
export function isUberCompatible(material) {
  if (!material || Array.isArray(material)) return false;
  if (!material.isMeshStandardNodeMaterial && !material.isMeshPhysicalNodeMaterial) return false;
  for (const slot of CUSTOM_NODE_SLOTS) {
    if (material[slot]?.isNode) return false;
  }
  // An emissive surface is a light source, not a shading table row: the GI
  // module promotes emissive meshes to emitters keyed on the mesh, and merging
  // one into a neighbour would move the light. Cheaper to refuse than to
  // carry emission through the table and then be wrong about where it is.
  if (material.emissive && material.emissive.getHex() !== 0x000000) return false;
  // Texture slots outside UBER_SLOTS would be silently dropped, which is the
  // one failure mode this whole system must not have.
  for (const slot of ["aoMap", "roughnessMap", "metalnessMap", "emissiveMap", "alphaMap", "bumpMap", "displacementMap", "clearcoatMap", "sheenColorMap", "specularMap", "lightMap", "envMap", "iridescenceMap", "transmissionMap", "anisotropyMap"]) {
    if (material[slot]) return false;
  }
  return true;
}

/**
 * What has to match for two textures to be layers of the same array: size,
 * wrapping and colour space. All three are properties of the ARRAY (one sampler,
 * one format for every layer), so a mismatch is not a thing the shader could
 * work around per layer.
 *
 * Returns `null` for an empty slot — which matches ANY signature, because a
 * neutral fill layer can be synthesised at whatever size the group settles on.
 */
export function slotSignature(texture_) {
  if (!texture_) return null;
  const image = texture_.image;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (!width || !height) return "unreadable";
  // A compressed (KTX2/Basis) texture has no drawable image, so it cannot be
  // copied into a layer without a GPU blit path this does not have.
  if (texture_.isCompressedTexture || texture_.isCompressedArrayTexture) return "unreadable";
  return `${width}x${height}|${texture_.wrapS}|${texture_.wrapT}|${texture_.colorSpace}|${texture_.flipY ? 1 : 0}`;
}

/**
 * Draws one source texture into `width x height` RGBA bytes.
 *
 * The vertical flip is the subtle part. three uploads an ordinary image texture
 * with `flipY`, so UV v=0 samples the image's BOTTOM row. The array this feeds
 * is a data texture uploaded with `flipY = false`, so the flip has to be baked
 * into the bytes here or every merged surface renders its texture upside down.
 */
function rasterise(source, width, height) {
  const image = source?.image;
  if (!image) return null;

  // Raw RGBA already in memory (a DataTexture, or anything the engine
  // generated rather than decoded): copy the bytes and skip the decode
  // entirely. `flipY` defaults false on data textures, matching the array's,
  // so an untouched buffer is already in the layout the layer wants.
  if (ArrayBuffer.isView(image.data) && image.width === width && image.height === height) {
    if (image.data.byteLength !== width * height * 4) return null;
    const bytes = new Uint8Array(image.data.buffer, image.data.byteOffset, width * height * 4);
    if (!source.flipY) return bytes.slice();
    const flipped = new Uint8Array(bytes.length);
    const row = width * 4;
    for (let y = 0; y < height; y++) {
      flipped.set(bytes.subarray(y * row, y * row + row), (height - 1 - y) * row);
    }
    return flipped;
  }

  const canvas = /** @type {any} */ (
    typeof OffscreenCanvas === "function"
      ? new OffscreenCanvas(width, height)
      : Object.assign(globalThis.document?.createElement?.("canvas") ?? {}, { width, height })
  );
  // A host with no 2D canvas (a headless run, a worker without OffscreenCanvas)
  // cannot decode an image into a layer. Returning null refuses the merge,
  // which is slower and correct.
  const context = canvas.getContext?.("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  if (source.flipY) {
    context.translate(0, height);
    context.scale(1, -1);
  }
  try {
    context.drawImage(image, 0, 0, width, height);
  } catch {
    // A tainted or not-yet-decoded source. Refusing here means the caller
    // falls back to unmerged draws, which is slower and correct.
    return null;
  }
  return new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);
}

/** Solid-colour fill for a material that leaves this slot empty. */
function fillLayer(width, height, rgba) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return data;
}

/**
 * Stacks `sources` (each a Texture or null) into one `DataArrayTexture`.
 * `null` entries become a neutral fill so the shader can sample every layer
 * unconditionally — a branch per fragment would cost more than a white layer.
 *
 * @returns {{texture: THREE.DataArrayTexture, layers: number[]} | null}
 */
export function buildLayeredTexture(sources, { neutral, colorSpace }) {
  const present = sources.filter(Boolean);
  if (!present.length) return null;
  const width = present[0].image?.width ?? 0;
  const height = present[0].image?.height ?? 0;
  if (!width || !height) return null;

  // One layer per DISTINCT source. Sponza shares no maps between materials, but
  // a scene that does would otherwise pay for the same megabytes twice.
  const layerOf = new Map();
  const data = new Uint8Array(width * height * 4 * (present.length + 1));
  const stride = width * height * 4;
  // Layer 0 is always the neutral fill: it is what an empty slot resolves to,
  // and having it at a fixed index means the caller never has to ask whether
  // this group happens to contain one.
  data.set(fillLayer(width, height, neutral), 0);
  let next = 1;
  for (const source of present) {
    if (layerOf.has(source)) continue;
    const pixels = rasterise(source, width, height);
    if (!pixels) return null;
    data.set(pixels, next * stride);
    layerOf.set(source, next);
    next++;
  }

  const array = new THREE.DataArrayTexture(data.subarray(0, next * stride), width, height, next);
  const template = present[0];
  array.colorSpace = colorSpace;
  array.wrapS = template.wrapS;
  array.wrapT = template.wrapT;
  array.magFilter = template.magFilter;
  array.minFilter = template.minFilter;
  array.anisotropy = present.reduce((n, t) => Math.max(n, t.anisotropy ?? 1), 1);
  array.generateMipmaps = true;
  // The bytes above already carry the flip (see `rasterise`); flipping again at
  // upload would undo it.
  array.flipY = false;
  array.needsUpdate = true;
  array.name = "UberArray";

  return { texture: array, layers: sources.map((s) => (s ? layerOf.get(s) ?? 0 : 0)) };
}

/**
 * Builds the material a merged group draws with.
 *
 * @param {any[]} materials source materials, in the order their `materialIndex`
 *   values were assigned by the merger.
 * @param {any} template the material whose pipeline flags the group agreed on.
 * @returns {{material: any, dispose: () => void, bytes: number} | null}
 *   `bytes` is filled in by the caller that budgets the cache; it is declared
 *   here so the shape the cache stores is the shape this returns.
 */
export function buildUberMaterial(materials, template) {
  const colorLayers = buildLayeredTexture(
    materials.map((m) => m.map ?? null),
    { neutral: [255, 255, 255, 255], colorSpace: THREE.SRGBColorSpace },
  );
  const normalLayers = buildLayeredTexture(
    materials.map((m) => m.normalMap ?? null),
    // Flat tangent-space normal: (0,0,1) encoded as (0.5, 0.5, 1).
    { neutral: [128, 128, 255, 255], colorSpace: THREE.NoColorSpace },
  );
  // A group where nobody binds anything has nothing for this material to index;
  // the merger should not have built it, and refusing is cheaper than a
  // material that is a slower way to write a constant.
  if (!colorLayers && !normalLayers) return null;

  // Two vec4s per material. Packed rather than one array per scalar because
  // each `uniformArray` is its own uniform buffer and its own binding, and the
  // point of this material is to have few of those.
  const row0 = materials.map((m, i) =>
    new THREE.Vector4(
      m.color?.r ?? 1,
      m.color?.g ?? 1,
      m.color?.b ?? 1,
      colorLayers ? colorLayers.layers[i] : 0,
    ),
  );
  const row1 = materials.map((m, i) =>
    new THREE.Vector4(
      m.roughness ?? 1,
      m.metalness ?? 0,
      m.normalScale?.x ?? 1,
      normalLayers ? normalLayers.layers[i] : 0,
    ),
  );
  const params0 = uniformArray(row0, "vec4");
  const params1 = uniformArray(row1, "vec4");

  // The index is a per-VERTEX attribute, and every vertex of a triangle carries
  // the same value, so interpolating it is exact — no flat qualifier needed.
  // `+0.5 then floor` rather than `round` so the conversion cannot land one
  // below the intended layer on a value that interpolated to 3.99999.
  // Casts: three's shipped `@types` describe TSL nodes by their class, which
  // does not carry the swizzle/operator members the runtime proxy provides.
  const index = /** @type {any} */ (attribute("materialIndex", "float")).add(0.5).floor().toInt();
  const p0 = /** @type {any} */ (params0.element(index));
  const p1 = /** @type {any} */ (params1.element(index));

  const material = new THREE.MeshPhysicalNodeMaterial();
  material.name = `Uber(${materials.length})`;
  material.side = template.side;
  material.transparent = template.transparent;
  material.opacity = template.opacity;
  material.alphaTest = template.alphaTest;
  material.blending = template.blending;
  material.depthTest = template.depthTest;
  material.depthWrite = template.depthWrite;
  material.toneMapped = template.toneMapped;
  material.fog = template.fog;
  material.wireframe = template.wireframe;
  material.ior = template.ior;
  material.specularIntensity = template.specularIntensity;
  if (material.specularColor && template.specularColor) material.specularColor.copy(template.specularColor);
  // Read by anything that inspects a material without running the shader — the
  // GI module's albedo atlas is the one that matters. It cannot index the array,
  // so it gets the group's average tint rather than a stale first-member value.
  const average = new THREE.Color(0, 0, 0);
  for (const m of materials) average.add(m.color ?? new THREE.Color(1, 1, 1));
  material.color.copy(average.multiplyScalar(1 / Math.max(1, materials.length)));
  material.roughness = row1.reduce((n, r) => n + r.x, 0) / Math.max(1, row1.length);
  material.metalness = row1.reduce((n, r) => n + r.y, 0) / Math.max(1, row1.length);

  if (colorLayers) {
    material.colorNode = vec4(
      texture(colorLayers.texture).depth(p0.w.toInt()).rgb.mul(vec3(p0.xyz)),
      1,
    );
  } else {
    material.colorNode = vec4(vec3(p0.xyz), 1);
  }
  if (normalLayers) {
    material.normalNode = normalMap(
      texture(normalLayers.texture).depth(p1.w.toInt()),
      vec2(p1.z, p1.z),
    );
  }
  material.roughnessNode = p1.x;
  material.metalnessNode = p1.y;

  return {
    material,
    // Set by MergeSystem once it has priced the group; see MAX_CACHED_TEXTURE_BYTES.
    bytes: 0,
    dispose() {
      colorLayers?.texture.dispose();
      normalLayers?.texture.dispose();
      material.dispose();
    },
  };
}
