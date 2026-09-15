import { Skeleton } from "three/webgpu";
import { resolveAssetUrl } from "./assetResolver.js";
import { getGltfLoader, rebaseClipToZero } from "./gltfLoader.js";
import { vmState } from "./vmState.js";
import { createRefCountedCache, assetPathKey, assetPathMatches } from "./refCountedCache.js";

/**
 * Parsed-GLB cache shared by every ModelComponent.
 *
 * N entities of one .glb used to mean N parses and N copies of every geometry,
 * material and texture — and because batching groups by
 * `geometry.uuid|material.uuid`, those copies could never merge. Now one parse
 * (the TEMPLATE, never added to a scene) is shared; each entity renders a clone
 * whose meshes reference the template's geometry and materials.
 *
 * Ownership: the template's geometries, materials and textures belong to the
 * cache and are disposed when the last entity releases it. Per-entity code must
 * REPLACE `mesh.material`/`mesh.geometry` (as .mat overrides and
 * SkinnedMeshComponent do), never mutate or dispose the shared instances.
 *
 * Keyed by the slash-normalised asset path, not the blob URL (the editor mints
 * a new URL per overwrite). `invalidateModelAsset` retires an entry when the
 * file changes so the next attach parses the new bytes.
 */

// A re-attach (prop change, Play/Stop restore, scene reconcile) releases and
// re-acquires within moments; holding the parse briefly avoids re-decoding.
const MODEL_EVICT_DELAY_MS = 1500;

const cache = vmState("modelAssetCache", () =>
  createRefCountedCache({
    load: (key, path) => parseModel(path),
    dispose: (template) => disposeModelTemplate(template),
    evictDelayMs: MODEL_EVICT_DELAY_MS,
  }),
);

async function parseModel(path) {
  const gltf = await getGltfLoader().loadAsync(await resolveAssetUrl(path));
  const scene = gltf.scene;
  let skinned = false;
  scene.traverse((object) => {
    if (object.isSkinnedMesh) skinned = true;
    // Provenance for derived-data sidecars (baked mesh SDFs): GLB-internal
    // geometries have no asset path of their own.
    if (object.isMesh && object.geometry && !object.geometry.userData.sourceModelPath) {
      object.geometry.userData.sourceModelPath = path;
    }
    // Marks materials every instance shares, so per-entity patchers
    // (PlanarReflectionComponent) clone before writing. `clone()` copies
    // userData, so a patcher deletes the flag on its private copy.
    if (object.isMesh) {
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        if (material) material.userData.modelTemplate = true;
      }
    }
  });
  // Rebased ONCE here: it shifts keyframe times in place, and the clip objects
  // are shared by every instance.
  const clips = (gltf.animations ?? []).map(rebaseClipToZero);
  return { path, scene, clips, skinned };
}

/** Borrows the parsed template for `path`. Pair with `releaseModelAsset`. */
export function acquireModelAsset(path) {
  return cache.acquire(assetPathKey(path), path);
}

/** Returns a template borrowed via `acquireModelAsset`. */
export function releaseModelAsset(template) {
  return cache.release(template);
}

/**
 * One entity's copy of a template: fresh Object3D hierarchy, shared geometry
 * and materials. Skinned hierarchies need SkeletonUtils — a plain clone keeps
 * every SkinnedMesh bound to the TEMPLATE's bones. The clip array is copied
 * (callers may append) while the clips themselves stay shared.
 */
export function instantiateModel(template) {
  const root = template.skinned ? cloneSkinnedHierarchy(template.scene) : template.scene.clone(true);
  return { root, clips: template.clips.slice() };
}

/**
 * SkeletonUtils.clone, minus the extra dependency: `clone(true)` keeps child
 * order, so a parallel traversal maps every template bone to its copy, and each
 * SkinnedMesh is rebound to a skeleton of ITS OWN bones (bone inverses shared,
 * they are read-only).
 */
function cloneSkinnedHierarchy(source) {
  const clone = source.clone(true);
  const sourceNodes = [];
  const cloneNodes = [];
  source.traverse((node) => sourceNodes.push(node));
  clone.traverse((node) => cloneNodes.push(node));
  const cloneOf = new Map(sourceNodes.map((node, index) => [node, cloneNodes[index]]));
  sourceNodes.forEach((node, index) => {
    if (!node.isSkinnedMesh || !node.skeleton) return;
    const target = cloneNodes[index];
    const bones = node.skeleton.bones.map((bone) => cloneOf.get(bone) ?? bone);
    target.bind(new Skeleton(bones, node.skeleton.boneInverses), target.bindMatrix);
  });
  return clone;
}

/** Retires cached parses of `path` (all when null) after the file changed. */
export function invalidateModelAsset(path = null) {
  if (path == null) return cache.invalidate();
  return cache.invalidate((key) => assetPathMatches(key, path));
}

/** Disposes unreferenced templates now (tests, memory pressure). */
export function flushModelAssetCache() {
  cache.flush();
}

/** Live reference count of a template (diagnostics/tests). */
export function modelAssetRefs(template) {
  return cache.refsOf(template);
}

/**
 * Every geometry, material and texture reachable from `root`, once each.
 * Textures are found by scanning material properties for `isTexture`
 * (`material.dispose()` never frees its maps). `isForeignMaterial` excludes
 * materials owned elsewhere (shared .mat instances) along with their maps.
 */
export function collectModelResources(root, isForeignMaterial = () => false) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root?.traverse?.((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (!material || materials.has(material) || isForeignMaterial(material)) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
    }
  });
  return { geometries, materials, textures };
}

function disposeModelTemplate(template) {
  const { geometries, materials, textures } = collectModelResources(template?.scene);
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  // ImageBitmaps are deliberately NOT closed: a device-loss renderer rebuild
  // re-uploads from `source.data`, and GI/merging read texture.image on the CPU.
  for (const texture of textures) texture.dispose();
}
