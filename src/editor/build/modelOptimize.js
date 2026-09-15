import { dedup, prune, weld } from "@gltf-transform/functions";

/**
 * Lossless model cleanup run at build time before Draco.
 *
 * Every option here leans towards KEEPING data, because the engine addresses
 * glTF content in ways a generic optimizer cannot see:
 *   - empty leaf nodes are sockets/attach points found by name → `keepLeaves`
 *   - an unused-looking UV set / vertex colour can feed GI, lightmaps or a
 *     material override assigned later in the editor → `keepAttributes`
 *   - a 1×1 texture may be swapped at runtime; folding it into a factor
 *     changes the material's shape → `keepSolidTextures`
 *   - `extras` carry engine metadata → `keepExtras`
 *   - distinctly named duplicates (materials/meshes looked up by name) stay
 *     distinct → dedup `keepUniqueNames`
 *
 * Deliberately NOT here: `quantize()` — KHR_mesh_quantization hands the
 * engine Int16/Uint16 attribute arrays, and the GI BVH, physics colliders and
 * navmesh all read geometry as Float32. Texture resizing is not done here
 * either (embedded images would need a browser/Node image codec).
 */
export const MODEL_PRUNE_OPTIONS = Object.freeze({
  keepLeaves: true,
  keepAttributes: true,
  keepIndices: true,
  keepSolidTextures: true,
  keepExtras: true,
});

export function modelOptimizeTransforms() {
  return [dedup({ keepUniqueNames: true }), prune({ ...MODEL_PRUNE_OPTIONS }), weld()];
}

/** Runs the cleanup chain on a gltf-transform Document in place. */
export async function optimizeModelDocument(doc) {
  await doc.transform(...modelOptimizeTransforms());
  return doc;
}
